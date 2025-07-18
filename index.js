const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');

const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());

['uploads', 'face-descriptors'].forEach(folder => {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder);
});

// ✅ Direct DB config (no .env)
const db = mysql.createConnection({
  host: 'tangent-rds-mysql.coqrofbynn8g.ap-south-1.rds.amazonaws.com',
  port: 3306,
  user: 'DEV_HR_MANAGEMENT_DBUSER',
  password: '7600c880%%155f&&02a9**f5473b5e',
  database: 'DEV_HR_MANAGEMENT'
});
db.connect(err => {
  if (err) console.error('❌ DB Error:', err);
  else console.log('✅ Connected to DB');
});

// ✅ Load models before server starts
(async () => {
  const MODEL_PATH = path.join(__dirname, 'models');

  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromDisk(path.join(MODEL_PATH, 'tiny_face_detector_model')),
    faceapi.nets.faceLandmark68Net.loadFromDisk(path.join(MODEL_PATH, 'face_landmark_68_model')),
    faceapi.nets.faceRecognitionNet.loadFromDisk(path.join(MODEL_PATH, 'face_recognition_model')),
  ]);
  
 
  console.log('✅ Models loaded. Starting server...');
  app.listen(port, () => console.log(`🚀 Server running at http://localhost:${port}`));
})();

// ✅ File Uploads (multer)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// ✅ Safe face descriptor function
async function getSafeFaceDescriptor(imagePath) {
  try {
    const img = await canvas.loadImage(imagePath);
    const c = canvas.createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const detection = await faceapi
      .detectSingleFace(c, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection || !detection.descriptor) {
      console.warn('⚠️ No face or descriptor found.');
      return null;
    }

    const descriptor = detection.descriptor;
    if (
      descriptor.length !== 128 ||
      descriptor.some(v => typeof v !== 'number' || isNaN(v))
    ) {
      console.warn('⚠️ Descriptor invalid or contains NaNs');
      return null;
    }

    return descriptor;
  } catch (err) {
    console.error('❌ getSafeFaceDescriptor error:', err.message);
    return null;
  }
}

// ✅ Register Face
app.post('/register-face', upload.single('image'), async (req, res) => {
  const { empId } = req.body;
  if (!req.file || !empId) return res.status(400).json({ error: 'Missing image or empId' });

  const imgPath = req.file.path;
  try {
    const descriptor = await getSafeFaceDescriptor(imgPath);
    if (!descriptor) return res.status(404).json({ error: 'No face detected or descriptor invalid' });
console.log(descriptor,"descriptor");

    const array = Array.from(descriptor);
    const faceId = `FACE_${Date.now()}`;
    fs.writeFileSync(path.join('face-descriptors', `${faceId}.json`),
      JSON.stringify({ empId, descriptor: array }, null, 2)
    );

    db.query(
      'INSERT INTO TBL_EMP_BIOMETRIC_INFO (EMP_SYS_ID, FACE_ID) VALUES (?, ?)',
      [empId, faceId],
      (err, results) => {
        if (err) {
          console.error('❌ DB Insert Error:', err);
          return res.status(500).json({ error: 'DB error', details: err.message });
        }
        res.json({ message: '✅ Face registered', faceId });
      }
    );
  } catch (err) {
    console.error('❌ Register error:', err);
    res.status(500).json({ error: 'Internal error', details: err.message });
  } finally {
    fs.unlink(imgPath, () => {});
  }
});

// ✅ Verify Face
// ✅ Verify Face using empId
app.post('/verify-face', upload.single('image'), async (req, res) => {
  const { empId } = req.body;
  if (!req.file || !empId) return res.status(400).json({ error: 'Missing image or empId' });

  const imgPath = req.file.path;

  try {
    // 1️⃣ Get faceId from DB
    db.query(
      'SELECT FACE_ID FROM TBL_EMP_BIOMETRIC_INFO WHERE EMP_SYS_ID = ?',
      [empId],
      async (err, results) => {
        if (err || results.length === 0) {
          console.error('❌ DB lookup error or empId not found');
          return res.status(404).json({ error: 'empId not found or DB error' });
        }

        const faceId = results[0].FACE_ID;
        const descriptor = await getSafeFaceDescriptor(imgPath);
        if (!descriptor) return res.status(404).json({ error: 'No face detected or descriptor invalid' });

        const stored = JSON.parse(fs.readFileSync(path.join('face-descriptors', `${faceId}.json`)));
        const savedDescriptor = new Float32Array(stored.descriptor);
        const distance = faceapi.euclideanDistance(descriptor, savedDescriptor);
        const verified = distance < 0.6;

        res.json({
          verified,
          message: verified ? '✅ Face matched!' : '❌ Face did not match',
          distance: Number(distance.toFixed(4)),
        });
      }
    );
  } catch (err) {
    console.error('❌ Verify error:', err);
    res.status(500).json({ error: 'Internal error', details: err.message });
  } finally {
    fs.unlink(imgPath, () => {});
  }
});



// ✅ Health Check
app.get('/', (req, res) => res.send('👋 Face Recognition Server is up!'));
