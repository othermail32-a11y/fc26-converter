const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const UPLOAD_DIR = '/tmp/uploads';
const OUTPUT_DIR = '/tmp/outputs';
const FRAMES_DIR = '/tmp/frames';

[UPLOAD_DIR, OUTPUT_DIR, FRAMES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname) || '.video'}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 * 1024 } });

const runCommand = (cmd, timeout = 600000) => new Promise((resolve, reject) => {
  exec(cmd, { timeout }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr || error.message));
    else resolve(stdout);
  });
});

// Get video duration in seconds
const getVideoDuration = (filePath) => new Promise((resolve, reject) => {
  ffmpeg.ffprobe(filePath, (err, metadata) => {
    if (err) reject(err);
    else resolve(metadata.format.duration || 0);
  });
});

// Extract frames from specific timestamps
// This is the key function — we always grab the final 2 minutes
const extractKeyFrames = async (videoPath, outputDir, jobId) => {
  const duration = await getVideoDuration(videoPath);
  const frameDir = path.join(outputDir, jobId);
  if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

  // Frame extraction strategy:
  // 1. RESULT FRAMES — last 3 minutes (most important for score detection)
  // 2. GAMEPLAY SAMPLES — evenly distributed through the match
  // 3. EARLY FRAMES — first 2 minutes (for team/kit identification)

  const timestamps = [];

  // Always grab dense frames from the final 3 minutes
  // FC26 shows the full-time result screen here
  const finalSectionStart = Math.max(0, duration - 180);
  for (let t = finalSectionStart; t <= duration; t += 15) {
    timestamps.push({ time: t, type: 'result' });
  }

  // Grab frames from the last 30 seconds specifically
  // This is where the full-time whistle and score confirmation screen appears
  const lastSectionStart = Math.max(0, duration - 30);
  for (let t = lastSectionStart; t <= duration; t += 5) {
    timestamps.push({ time: t, type: 'final_score' });
  }

  // Evenly distributed gameplay frames through the match
  const gameplaySections = 16;
  for (let i = 0; i < gameplaySections; i++) {
    const t = (duration / gameplaySections) * i;
    timestamps.push({ time: t, type: 'gameplay' });
  }

  // First 2 minutes for kit/team identification
  for (let t = 30; t <= Math.min(120, duration); t += 20) {
    timestamps.push({ time: t, type: 'team_id' });
  }

  // Extract all frames
  const extractedFrames = [];
  for (const ts of timestamps) {
    const frameName = `${ts.type}_${Math.round(ts.time)}s.jpg`;
    const framePath = path.join(frameDir, frameName);
    try {
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .seekInput(ts.time)
          .frames(1)
          .output(framePath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      if (fs.existsSync(framePath)) {
        extractedFrames.push({
          path: framePath,
          timestamp: ts.time,
          type: ts.type,
          name: frameName
        });
      }
    } catch (e) {
      // Skip failed frame extractions silently
    }
  }

  // Sort so result frames come FIRST — OpenAI sees these first
  extractedFrames.sort((a, b) => {
    const priority = { final_score: 0, result: 1, team_id: 2, gameplay: 3 };
    return (priority[a.type] || 3) - (priority[b.type] || 3);
  });

  return { frames: extractedFrames, duration, frameDir };
};

// Cleanup frame directory
const cleanupFrames = (frameDir) => {
  try {
    if (fs.existsSync(frameDir)) {
      fs.readdirSync(frameDir).forEach(f => fs.unlinkSync(path.join(frameDir, f)));
      fs.rmdirSync(frameDir);
    }
  } catch (e) {}
};

const cleanup = (...paths) => paths.forEach(p => {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
});

// Remux (fast)
const remux = (input, output) => new Promise((resolve, reject) => {
  ffmpeg(input)
    .outputOptions(['-c copy', '-movflags faststart'])
    .output(output)
    .on('end', () => resolve('remux'))
    .on('error', reject)
    .run();
});

// Re-encode (slow fallback)
const reencode = (input, output) => new Promise((resolve, reject) => {
  ffmpeg(input)
    .outputOptions(['-c:v libx264', '-c:a aac', '-crf 28', '-preset fast', '-vf scale=-2:720', '-r 24', '-movflags faststart'])
    .output(output)
    .on('end', () => resolve('reencode'))
    .on('error', reject)
    .run();
});

const convert = async (input, output) => {
  try { return await remux(input, output); }
  catch (e) {
    if (fs.existsSync(output)) fs.unlinkSync(output);
    return await reencode(input, output);
  }
};

const sendFile = (res, filePath, inputPath, method, inputSizeMB) => {
  const outputSizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="converted.mp4"');
  res.setHeader('X-Conversion-Method', method);
  res.setHeader('X-Input-Size-MB', inputSizeMB);
  res.setHeader('X-Output-Size-MB', outputSizeMB);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('end', () => cleanup(inputPath, filePath));
};

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', version: 'v3-smart-frames' }));

// File upload + convert
app.post('/convert', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const outputPath = path.join(OUTPUT_DIR, `${uuidv4()}.mp4`);
  const inputSizeMB = (req.file.size / 1024 / 1024).toFixed(1);
  try {
    const method = await convert(inputPath, outputPath);
    sendFile(res, outputPath, inputPath, method, inputSizeMB);
  } catch (err) {
    cleanup(inputPath, outputPath);
    res.status(500).json({ error: 'Conversion failed', message: err.message });
  }
});

// Extract key frames for analysis — returns frame metadata + prioritized frame order
// Lovable app calls this, gets back frame list with result frames first
app.post('/extract-frames', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const jobId = uuidv4();

  try {
    const { frames, duration, frameDir } = await extractKeyFrames(inputPath, FRAMES_DIR, jobId);

    // Return frame info — the app will fetch individual frames via /frame/:jobId/:frameName
    res.json({
      jobId,
      duration: Math.round(duration),
      totalFrames: frames.length,
      frames: frames.map(f => ({
        name: f.name,
        timestamp: f.timestamp,
        type: f.type,
        url: `/frame/${jobId}/${f.name}`
      })),
      message: `Extracted ${frames.length} frames. Result/score frames are prioritized first.`
    });

    cleanup(inputPath);

  } catch (err) {
    cleanup(inputPath);
    res.status(500).json({ error: 'Frame extraction failed', message: err.message });
  }
});

// Serve individual frame
app.get('/frame/:jobId/:frameName', (req, res) => {
  const framePath = path.join(FRAMES_DIR, req.params.jobId, req.params.frameName);
  if (!fs.existsSync(framePath)) return res.status(404).json({ error: 'Frame not found' });
  res.setHeader('Content-Type', 'image/jpeg');
  fs.createReadStream(framePath).pipe(res);
});

// Cleanup frames after analysis is done
app.delete('/frames/:jobId', (req, res) => {
  const frameDir = path.join(FRAMES_DIR, req.params.jobId);
  cleanupFrames(frameDir);
  res.json({ success: true });
});

// Twitch URL
app.post('/convert-twitch', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  const downloadPath = path.join(UPLOAD_DIR, `${uuidv4()}.mp4`);
  const outputPath = path.join(OUTPUT_DIR, `${uuidv4()}.mp4`);
  try {
    await runCommand(`twitch-dl download "${url}" --output "${downloadPath}" --quality 720p --overwrite`);
    if (!fs.existsSync(downloadPath)) throw new Error('Download file not found');
    const inputSizeMB = (fs.statSync(downloadPath).size / 1024 / 1024).toFixed(1);
    const method = await convert(downloadPath, outputPath);
    sendFile(res, outputPath, downloadPath, `twitch+${method}`, inputSizeMB);
  } catch (err) {
    cleanup(downloadPath, outputPath);
    let msg = 'Could not download this Twitch video.';
    if (err.message.includes('private') || err.message.includes('subscriber')) msg = 'This VOD is subscriber-only or private. Please upload the file directly.';
    else if (err.message.includes('expired') || err.message.includes('not found')) msg = 'This VOD has expired or been deleted. Twitch VODs are only kept for 60 days.';
    res.status(500).json({ error: msg });
  }
});

// YouTube URL
app.post('/convert-youtube', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  const downloadPath = path.join(UPLOAD_DIR, `${uuidv4()}.mp4`);
  const outputPath = path.join(OUTPUT_DIR, `${uuidv4()}.mp4`);
  try {
    await runCommand(`yt-dlp "${url}" -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]" --merge-output-format mp4 -o "${downloadPath}"`);
    if (!fs.existsSync(downloadPath)) throw new Error('Download file not found');
    const inputSizeMB = (fs.statSync(downloadPath).size / 1024 / 1024).toFixed(1);
    const method = await convert(downloadPath, outputPath);
    sendFile(res, outputPath, downloadPath, `youtube+${method}`, inputSizeMB);
  } catch (err) {
    cleanup(downloadPath, outputPath);
    let msg = 'Could not download this YouTube video.';
    if (err.message.includes('private')) msg = 'This video is private. Set it to Public or Unlisted.';
    res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => console.log(`FC26 Converter v3 running on port ${PORT}`));
