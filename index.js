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
const port = 3001;

app.use(cors());
app.use(bodyParser.json());

// Create folders if not exist
['uploads', 'face-descriptors'].forEach(folder => {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder);
});

// MySQL DB
const db = mysql.createConnection({
  host: 'tangent-rds-mysql.coqrofbynn8g.ap-south-1.rds.amazonaws.com',
  port: 3306,
  user: 'DEV_HR_MANAGEMENT_DBUSER',
  password: '7600c880%%155f&&02a9**f5473b5e',
  database: 'DEV_HR_MANAGEMENT'
});
db.connect(err => {
  if (err) console.error('DB Error:', err);
  else console.log('Connected to DB');
});

// Load face-api models
(async () => {
  const MODEL_PATH = path.join(__dirname, 'models');

  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromDisk(path.join(MODEL_PATH, 'tiny_face_detector_model')),
    faceapi.nets.faceLandmark68Net.loadFromDisk(path.join(MODEL_PATH, 'face_landmark_68_model')),
    faceapi.nets.faceRecognitionNet.loadFromDisk(path.join(MODEL_PATH, 'face_recognition_model')),
  ]);

  console.log('Models loaded. Starting server...');
  app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
})();

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// Descriptor extractor
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

    if (!detection || !detection.descriptor) return null;

    const descriptor = detection.descriptor;
    if (descriptor.length !== 128 || descriptor.some(v => typeof v !== 'number' || isNaN(v))) return null;

    return descriptor;
  } catch (err) {
    console.error('getSafeFaceDescriptor error:', err.message);
    return null;
  }
}

// ✅ Register Face API
app.post('/register-face', upload.single('image'), async (req, res) => {
  const { empId } = req.body;
  if (!req.file || !empId)
    return res.status(400).json({ error: 'Missing image or empId' });

  const imgPath = req.file.path;

  try {
    const descriptor = await getSafeFaceDescriptor(imgPath);
    if (!descriptor)
      return res.status(404).json({ error: 'No face detected or descriptor invalid' });

    const descriptorArray = Array.from(descriptor); // convert Float32Array to normal array
    const faceId = `FACE_${Date.now()}`;
    const descriptorJson = JSON.stringify(descriptorArray); // string to store in MySQL

    // Store faceId + descriptor in DB
    db.query(
      'INSERT INTO TBL_EMP_BIOMETRIC_INFO (EMP_SYS_ID, FACE_ID, FACE_DESCRIPTOR) VALUES (?, ?, ?)',
      [empId, faceId, descriptorJson],
      (err) => {
        if (err) {
          return res.status(500).json({ error: 'DB error', details: err.message });
        }
        res.json({ message: 'Face registered', faceId });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error', details: err.message });
  } finally {
    fs.unlink(imgPath, () => {}); // clean up image file
  }
});


// ✅ Compare Face API (empId + newImage)
app.post('/compare-face', upload.single('newImage'), async (req, res) => {
  const { empId } = req.body;
  const newImg = req.file;

  if (!empId || !newImg) {
    return res.status(400).json({ error: 'Missing empId or new image' });
  }

  try {
    db.query(
      'SELECT FACE_DESCRIPTOR FROM TBL_EMP_BIOMETRIC_INFO WHERE EMP_SYS_ID = ?',
      [empId],
      async (err, results) => {
        if (err || results.length === 0) {
          fs.unlink(newImg.path, () => {});
          return res.status(404).json({ error: 'Employee or face not registered' });
        }

        const storedDescriptorJson = results[0].FACE_DESCRIPTOR;
        if (!storedDescriptorJson) {
          fs.unlink(newImg.path, () => {});
          return res.status(404).json({ error: 'Face descriptor missing in DB' });
        }

        const registeredDescriptor = new Float32Array(JSON.parse(storedDescriptorJson));

        const newDescriptor = await getSafeFaceDescriptor(newImg.path);
        if (!newDescriptor) {
          fs.unlink(newImg.path, () => {});
          return res.status(404).json({ error: 'Face not detected in new image' });
        }

        const distance = faceapi.euclideanDistance(registeredDescriptor, newDescriptor);
        const verified = distance < 0.6;

        res.json({
          verified,
          message: verified ? 'Face matched' : 'Face did not match',
          distance: distance.toFixed(4),
        });

        fs.unlink(newImg.path, () => {});
      }
    );
  } catch (err) {
    fs.unlink(newImg.path, () => {});
    res.status(500).json({ error: 'Compare error', details: err.message });
  }
});

//get for face


app.get('/face-list', (req, res) => {
  const empId = req.query.empId;
  if (!empId) return res.status(400).json({ error: 'Missing empId in query' });

  const descriptorDir = path.join(__dirname, 'face-descriptors');

  fs.readdir(descriptorDir, (err, files) => {
    if (err) {
      return res.status(500).json({ error: 'Unable to read face-descriptors folder' });
    }

    const matchedFaces = [];

    files.forEach((file) => {
      const filePath = path.join(descriptorDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const jsonData = JSON.parse(content);
        if (jsonData.empId === empId) {
          matchedFaces.push({
            faceId: file.replace('.json', ''),
            descriptorLength: jsonData.descriptor.length
          });
        }
      } catch (err) {
        console.warn(`Invalid file: ${file}`);
      }
    });

    res.json({
      empId,
      count: matchedFaces.length,
      faces: matchedFaces
    });
  });
});


// ✅ Home route
app.get('/', (req, res) => res.send('Face Comparison Server is running'));
