const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from your Lovable app
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Store uploads temporarily
const UPLOAD_DIR = '/tmp/uploads';
const OUTPUT_DIR = '/tmp/outputs';

// Create dirs if they don't exist
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Multer config — accept any video file up to 10GB
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.video';
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10GB
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'FC26 Converter running' });
});

// Main conversion endpoint
app.post('/convert', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file uploaded' });
  }

  const inputPath = req.file.path;
  const outputFileName = `${uuidv4()}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputFileName);

  console.log(`Converting: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);

  // First try fast remux (copy streams, no re-encode)
  // This works for files that are already H.264 in a different container
  const tryRemux = () => {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-c copy',        // Copy streams without re-encoding
          '-movflags faststart'  // Optimize for streaming
        ])
        .output(outputPath)
        .on('end', () => resolve('remux'))
        .on('error', (err) => reject(err))
        .run();
    });
  };

  // Full re-encode fallback for incompatible formats
  const tryReencode = () => {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-c:v libx264',       // H.264 video
          '-c:a aac',           // AAC audio
          '-crf 28',            // Quality (lower = better, 28 is good balance)
          '-preset fast',       // Speed/compression balance
          '-vf scale=-2:720',   // Max 720p, maintain aspect ratio
          '-r 24',              // 24fps
          '-movflags faststart' // Optimize for streaming
        ])
        .output(outputPath)
        .on('progress', (progress) => {
          console.log(`Re-encoding: ${Math.round(progress.percent || 0)}%`);
        })
        .on('end', () => resolve('reencode'))
        .on('error', (err) => reject(err))
        .run();
    });
  };

  try {
    let method;

    // Try remux first — much faster
    try {
      method = await tryRemux();
      console.log('Remux succeeded');
    } catch (remuxErr) {
      console.log('Remux failed, trying full re-encode...');
      // If remux fails, do full re-encode
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      method = await tryReencode();
      console.log('Re-encode succeeded');
    }

    // Get output file size
    const outputStats = fs.statSync(outputPath);
    const outputSizeMB = (outputStats.size / 1024 / 1024).toFixed(1);
    const inputSizeMB = (req.file.size / 1024 / 1024).toFixed(1);

    console.log(`Done: ${inputSizeMB}MB → ${outputSizeMB}MB via ${method}`);

    // Send the converted file back
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="converted.mp4"`);
    res.setHeader('X-Conversion-Method', method);
    res.setHeader('X-Input-Size-MB', inputSizeMB);
    res.setHeader('X-Output-Size-MB', outputSizeMB);

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);

    readStream.on('end', () => {
      // Cleanup temp files
      try {
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
      } catch (e) {
        console.log('Cleanup error (non-critical):', e.message);
      }
    });

  } catch (err) {
    console.error('Conversion failed:', err.message);

    // Cleanup on error
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch (e) {}

    res.status(500).json({
      error: 'Conversion failed',
      message: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`FC26 Converter server running on port ${PORT}`);
});
