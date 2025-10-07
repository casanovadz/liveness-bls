// server.js
'use strict';

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------
// CORS / Body parsing setup
// -------------------------
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  // إضافة Cache-Control و Accept لأن المتصفح ربما يرسلهم في preflight
  allowedHeaders: ['Content-Type', 'Cache-Control', 'Accept', 'Authorization', 'X-Requested-With'],
  credentials: true
}));

// ضمان رد على طلبات preflight OPTIONS
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Accept, Authorization, X-Requested-With');
  return res.sendStatus(200);
});

// قراءة JSON / form-urlencoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------------------------
// قاعدة بيانات SQLite
// -------------------------
const dbPath = path.join(__dirname, 'liveness.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Error opening database:', err);
  } else {
    console.log('✅ Connected to SQLite database');
  }
});

// إنشاء الجداول إن لم تكن موجودة
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
  )`, (err) => {
    if (err) {
      console.error('❌ Error creating table:', err);
    } else {
      console.log('✅ Table ready');
    }
  });
});

// -------------------------
// Routes (endpoints)
// -------------------------

// 1) استرجاع البيانات بواسطة user_id
app.get('/retrieve_data.php', (req, res) => {
  const userId = req.query.user_id;
  console.log('📥 GET /retrieve_data.php?user_id=', userId);

  if (!userId) {
    return res.status(400).json({ error: 'user_id parameter is required' });
  }

  db.all("SELECT * FROM liveness_data WHERE user_id = ?", [userId], (err, rows) => {
    if (err) {
      console.error('❌ Database error:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log('✅ Data retrieved:', rows.length, 'records');
    res.json(rows);
  });
});

// 2) تخزين بيانات IP المزيف (تتوقع Array في body)
app.post('/get_ip.php', (req, res) => {
  const data = req.body;
  console.log('📤 POST /get_ip.php', data);

  if (Array.isArray(data) && data.length > 0) {
    const { spoof_ip, user_id, transaction_id, liveness_id } = data[0];

    if (!user_id || !transaction_id || !spoof_ip) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    db.run(
      `INSERT OR REPLACE INTO liveness_data 
         (user_id, transaction_id, liveness_id, spoof_ip) 
       VALUES (?, ?, ?, ?)`,
      [user_id, transaction_id, liveness_id, spoof_ip],
      function(err) {
        if (err) {
          console.error('❌ Database error:', err);
          return res.status(500).json({ error: err.message });
        }
        console.log('✅ Data stored - ID:', this.lastID);
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

// 4) تحديث نتائج التحقق (update_liveness.php)
app.post('/update_liveness.php', (req, res) => {
  const { user_id, liveness_id, spoof_ip, transaction_id } = req.body;
  console.log('📥 POST /update_liveness.php', req.body);

  if (!user_id || !liveness_id || !transaction_id) {
    return res.status(400).json({
      success: false,
      message: 'بيانات ناقصة: user_id, liveness_id, transaction_id مطلوبة'
    });
  }

  db.run(
    `UPDATE liveness_data 
       SET liveness_id = ?, status = 'completed', spoof_ip = COALESCE(?, spoof_ip)
       WHERE user_id = ? AND transaction_id = ?`,
    [liveness_id, spoof_ip, user_id, transaction_id],
    function(err) {
      if (err) {
        console.error('❌ Database error:', err);
        return res.status(500).json({
          success: false,
          message: 'خطأ في قاعدة البيانات: ' + err.message
        });
      }

      if (this.changes === 0) {
        // لم نجد السجل — ننشئه
        db.run(
          `INSERT INTO liveness_data 
             (user_id, transaction_id, liveness_id, spoof_ip, status) 
           VALUES (?, ?, ?, ?, 'completed')`,
          [user_id, transaction_id, liveness_id, spoof_ip],
          function(insertErr) {
            if (insertErr) {
              console.error('❌ Insert error:', insertErr);
              return res.status(500).json({
                success: false,
                message: 'خطأ في إنشاء السجل: ' + insertErr.message
              });
            }
            console.log('✅ New record created - ID:', this.lastID);
            res.json({
              success: true,
              message: 'تم حفظ نتائج التحقق بنجاح',
              id: this.lastID,
              status: 'completed'
            });
          }
        );
      } else {
        console.log('✅ Liveness results updated - changes:', this.changes);
        res.json({
          success: true,
          message: 'تم تحديث نتائج التحقق بنجاح',
          changes: this.changes,
          status: 'completed'
        });
      }
    }
  );
});

// 5) قراءة حالة آخر عملية للمستخدم
app.get('/user_status.php', (req, res) => {
  const userId = req.query.user_id;

  if (!userId) {
    return res.status(400).json({ error: 'user_id parameter is required' });
  }

  db.get(
    "SELECT user_id, transaction_id, spoof_ip, status, created_at FROM liveness_data WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
    [userId],
    (err, row) => {
      if (err) {
        console.error('❌ Database error:', err);
        return res.status(500).json({ error: err.message });
      }

      if (row) {
        res.json({
          success: true,
          data: row
        });
      } else {
        res.json({
          success: false,
          message: 'لم يتم العثور على بيانات للمستخدم'
        });
      }
    }
  );
});

// Health + homepage
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    server: 'liveness-bls.uk',
    version: '2.0',
    timestamp: new Date().toISOString(),
    endpoints: {
      retrieve_data: 'GET /retrieve_data.php?user_id=USER_ID',
      store_spoof_ip: 'POST /get_ip.php',
      update_liveness: 'POST /update_liveness.php'
    }
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Liveness BLS Server is running',
    status: 'OK',
    timestamp: new Date().toISOString()
  });
});

// مثال للـ frontend snippet ليعرض كيفية الاستبدال
app.get('/frontend_snippet', (req, res) => {
  res.type('text/plain').send(`// مثال: استبدال تحديث مباشر بـ استخدام get_ip.php كما طلبت
const res = await fetch("https://liveness-bls.onrender.com/get_ip.php", {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify([{
    user_id: "\${userData.user_id}",
    liveness_id: result.event_session_id,
    spoof_ip: "\${userData.spoof_ip}",
    transaction_id: "\${userData.transaction_id}"
  }])
});`);
});

// -------------------------
// تنظيف البيانات القديمة (كل ساعة)
// -------------------------
setInterval(() => {
  db.run("DELETE FROM liveness_data WHERE created_at < datetime('now', '-2 hours')", (err) => {
    if (err) {
      console.error('❌ Error cleaning old data:', err);
    } else {
      console.log('✅ Old data cleaned');
    }
  });
}, 60 * 60 * 1000); // كل ساعة

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Liveness BLS Server running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
  console.log(`📍 Retrieve example: http://localhost:${PORT}/retrieve_data.php?user_id=test123`);
});
