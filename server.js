// إصلاح CORS في الخادم
app.use(cors({
    origin: ['https://algeria.blsspainglobal.com', 'chrome-extension://*'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// معالجة طلبات OPTIONS
app.options('*', cors());

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// استخدم قاعدة بيانات ملف بدلاً من الذاكرة
const db = new sqlite3.Database('./liveness.db');

// إنشاء الجداول
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS liveness_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE,
    transaction_id TEXT,
    liveness_id TEXT,
    spoof_ip TEXT,
    client_ip TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// 1. استرجاع البيانات بواسطة user_id
app.get('/retrieve_data.php', (req, res) => {
  const userId = req.query.user_id;
  
  if (!userId) {
    return res.status(400).json({ error: 'user_id parameter is required' });
  }
  
  db.all("SELECT * FROM liveness_data WHERE user_id = ?", [userId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// 2. تخزين بيانات IP المزيف
app.post('/get_ip.php', (req, res) => {
  const data = req.body;
  
  if (Array.isArray(data) && data.length > 0) {
    const { spoof_ip, user_id, transaction_id, liveness_id } = data[0];
    
    db.run(
      `INSERT OR REPLACE INTO liveness_data 
       (user_id, transaction_id, liveness_id, spoof_ip) 
       VALUES (?, ?, ?, ?)`,
      [user_id, transaction_id, liveness_id, spoof_ip],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({ 
          success: true,
          message: 'Spoof IP data stored successfully',
          id: this.lastID 
        });
      }
    );
  } else {
    res.status(400).json({ error: 'Invalid data format' });
  }
});

// 3. تخزين IP العميل الحقيقي
app.post('/client_data.php', (req, res) => {
  const { user_id, client_ip } = req.body;
  
  if (!user_id || !client_ip) {
    return res.status(400).json({ error: 'user_id and client_ip are required' });
  }
  
  db.run(
    `UPDATE liveness_data SET client_ip = ? WHERE user_id = ?`,
    [client_ip, user_id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ 
        success: true,
        message: 'Client IP stored successfully',
        changes: this.changes
      });
    }
  );
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    server: 'liveness-bls.uk',
    version: '2.0',
    timestamp: new Date().toISOString(),
    endpoints: {
      retrieve_data: 'GET /retrieve_data.php?user_id=USER_ID',
      store_spoof_ip: 'POST /get_ip.php',
      store_client_ip: 'POST /client_data.php'
    }
  });
});

// تنظيف البيانات القديمة (كل ساعة)
setInterval(() => {
  db.run("DELETE FROM liveness_data WHERE created_at < datetime('now', '-2 hours')", (err) => {
    if (err) {
      console.error('Error cleaning old data:', err);
    } else {
      console.log('Old data cleaned successfully');
    }
  });
}, 3600000);

app.listen(PORT, () => {
  console.log(`🚀 Liveness BLS Server running on port ${PORT}`);
  console.log(`📍 Health check: https://liveness-bls.onrender.com/health`);
});

// معالجة الأخطاء غير الملتقطة
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
