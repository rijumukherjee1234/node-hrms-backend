const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

// Face recognition packages
const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');

// For face-api.js environment
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());

// Create folders if not exists
['uploads', 'face-descriptors'].forEach(folder => {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder);
});

// DB connection
const db = mysql.createConnection({
  host: 'tangent-rds-mysql.coqrofbynn8g.ap-south-1.rds.amazonaws.com',
  port: 3306,
  user: 'DEV_HR_MANAGEMENT_DBUSER',
  password: '7600c880%%155f&&02a9**f5473b5e',
  database: 'DEV_HR_MANAGEMENT'
});

db.connect((err) => {
  if (err) console.error('❌ DB Error:', err);
  else console.log('✅ Connected to DB');
});

// Load face-api models
const MODEL_PATH = path.join(__dirname, 'models');
Promise.all([
  faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_PATH),
  faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_PATH),
  faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_PATH),
]).then(() => {
  console.log('✅ FaceAPI models loaded');
});

// Multer config
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (_, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage });

// ✅ API to register face
app.post('/register-face', upload.single('image'), async (req, res) => {
  const empId = req.body.empId;

  if (!req.file || !empId) {
    return res.status(400).json({ error: 'Missing image or empId' });
  }

  const imgPath = path.join(__dirname, 'uploads', req.file.filename);
  const img = await canvas.loadImage(imgPath);

  const detections = await faceapi
    .detectSingleFace(img)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detections) {
    return res.status(404).json({ error: 'No face detected' });
  }

  // Save descriptor as JSON
  const descriptor = Array.from(detections.descriptor);
  const faceId = `FACE_${Date.now()}`;
  const descriptorPath = path.join(__dirname, 'face-descriptors', `${faceId}.json`);
  fs.writeFileSync(descriptorPath, JSON.stringify({ descriptor, empId }));

  // Save to DB
  const sql = `INSERT INTO TBL_EMP_BIOMETRIC_INFO (EMP_SYS_ID, FACE_ID) VALUES (?, ?)`;
  db.query(sql, [empId, faceId], (err, result) => {
    if (err) {
      console.error('❌ DB insert error:', err);
      return res.status(500).json({ message: 'Insert failed' });
    }

    res.json({
      message: '✅ Face registered successfully',
      faceId,
      dbId: result.insertId,
    });
  });
});
// ✅ API to verify face
app.post('/verify-face', upload.single('image'), async (req, res) => {
    const empId = req.body.empId;
  
    if (!req.file || !empId) {
      return res.status(400).json({ error: 'Missing image or empId' });
    }
  
    const imgPath = path.join(__dirname, 'uploads', req.file.filename);
    const img = await canvas.loadImage(imgPath);
  
    const uploadedDetection = await faceapi
      .detectSingleFace(img)
      .withFaceLandmarks()
      .withFaceDescriptor();
  
    if (!uploadedDetection) {
      return res.status(404).json({ error: 'No face detected in uploaded image' });
    }
  
    // Read stored face descriptors
    const descriptorDir = path.join(__dirname, 'face-descriptors');
    const descriptorFiles = fs.readdirSync(descriptorDir);
  
    let matchFound = false;
    let bestDistance = Infinity;
  
    for (const file of descriptorFiles) {
      const data = JSON.parse(fs.readFileSync(path.join(descriptorDir, file)));
      if (data.empId !== empId) continue;
  
      const storedDescriptor = new Float32Array(data.descriptor);
      const distance = faceapi.euclideanDistance(uploadedDetection.descriptor, storedDescriptor);
  
      if (distance < 0.6) { // 0.6 is threshold for match
        matchFound = true;
        bestDistance = distance;
        break;
      } else {
        bestDistance = Math.min(bestDistance, distance);
      }
    }
  
    if (matchFound) {
      res.json({
        verified: true,
        message: '✅ Face matched',
        distance: bestDistance.toFixed(4),
      });
    } else {
      res.json({
        verified: false,
        message: '❌ Face did not match',
        distance: bestDistance.toFixed(4),
      });
    }
  });
  

// Test
app.get('/', (req, res) => {
  res.send('👋 Face Recognition Server is up!');
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
