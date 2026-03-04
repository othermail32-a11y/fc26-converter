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
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname) || '.video'}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 * 1024 } });

// Run shell command
const runCommand = (cmd, timeout = 600000) => new Promise((resolve, reject) => {
  exec(cmd, { timeout }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr || error.message));
    else resolve(stdout);
  });
});

// Remux (fast - no re-encode)
const remux = (input, output) => new Promise((resolve, reject) => {
  ffmpeg(input)
    .outputOptions(['-c copy', '-movflags faststart'])
    .output(output)
    .on('end', () => resolve('remux'))
    .on('error', reject)
    .run();
});

// Re-encode (slow - full conversion)
const reencode = (input, output) => new Promise((resolve, reject) => {
  ffmpeg(input)
    .outputOptions(['-c:v libx264', '-c:a aac', '-crf 28', '-preset fast', '-vf scale=-2:720', '-r 24', '-movflags faststart'])
    .output(output)
    .on('end', () => resolve('reencode'))
    .on('error', reject)
    .run();
});

// Smart convert — remux first, re-encode if needed
const convert = async (input, output) => {
  try {
    return await remux(input, output);
  } catch (e) {
    if (fs.existsSync(output)) fs.unlinkSync(output);
    return await reencode(input, output);
  }
};

// Send converted file to client
const sendFile = (res, filePath, inputPath, method, inputSizeMB) => {
  const outputSizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="converted.mp4"');
  res.setHeader('X-Conversion-Method', method);
  res.setHeader('X-Input-Size-MB', inputSizeMB);
  res.setHeader('X-Output-Size-MB', outputSizeMB);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('end', () => {
    try {
      if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {}
  });
};

const cleanup = (...paths) => paths.forEach(p => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {} });

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// File upload
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

// Twitch URL (clips and VODs)
app.post('/convert-twitch', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const downloadPath = path.join(UPLOAD_DIR, `${uuidv4()}.mp4`);
  const outputPath = path.join(OUTPUT_DIR, `${uuidv4()}.mp4`);

  try {
    console.log(`Downloading Twitch: ${url}`);
    await runCommand(`twitch-dl download "${url}" --output "${downloadPath}" --quality 720p --overwrite`);

    if (!fs.existsSync(downloadPath)) throw new Error('Download file not found after completion');

    const inputSizeMB = (fs.statSync(downloadPath).size / 1024 / 1024).toFixed(1);
    const method = await convert(downloadPath, outputPath);
    sendFile(res, outputPath, downloadPath, `twitch+${method}`, inputSizeMB);

  } catch (err) {
    cleanup(downloadPath, outputPath);
    let msg = 'Could not download this Twitch video.';
    if (err.message.includes('private') || err.message.includes('subscriber')) msg = 'This VOD is subscriber-only or private. Please upload the file directly.';
    else if (err.message.includes('expired') || err.message.includes('not found')) msg = 'This VOD has expired or been deleted. Twitch VODs are only kept for 60 days.';
    else if (err.message.includes('timeout')) msg = 'Download timed out. Try a shorter clip URL.';
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
    console.log(`Downloading YouTube: ${url}`);
    await runCommand(`yt-dlp "${url}" -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]" --merge-output-format mp4 -o "${downloadPath}"`);

    if (!fs.existsSync(downloadPath)) throw new Error('Download file not found after completion');

    const inputSizeMB = (fs.statSync(downloadPath).size / 1024 / 1024).toFixed(1);
    const method = await convert(downloadPath, outputPath);
    sendFile(res, outputPath, downloadPath, `youtube+${method}`, inputSizeMB);

  } catch (err) {
    cleanup(downloadPath, outputPath);
    let msg = 'Could not download this YouTube video.';
    if (err.message.includes('private')) msg = 'This video is private. Set it to Public or Unlisted.';
    else if (err.message.includes('age')) msg = 'This video has age restrictions preventing download.';
    res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => console.log(`FC26 Converter running on port ${PORT}`));
