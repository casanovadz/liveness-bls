// server.js — محدث ومتوافق مع الإضافة
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// إعداد CORS محسّن
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'Accept',
    'X-Requested-With',
    'Origin'
  ],
  credentials: true,
  maxAge: 86400
}));

// معالجة preflight
app.options('*', cors());

// ---------- قاعدة البيانات ----------
const dbPath = path.join(__dirname, 'liveness.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Error opening database:', err);
  } else {
    console.log('✅ Connected to SQLite database');
  }
});

// إنشاء الجدول إذا لم يكن موجودًا
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
    if (err) console.error('❌ Error creating table:', err);
    else console.log('✅ Table ready');
  });
});

// ---------- Endpoints ----------

// 0. صفحة رئيسية
app.get('/', (req, res) => {
  res.json({
    message: 'Liveness BLS Server is running',
    status: 'OK',
    timestamp: new Date().toISOString()
  });
});

// 1. استرجاع البيانات بواسطة user_id
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
    console.log('✅ Data retrieved:', rows.length, 'records for', userId);
    res.json(rows);
  });
});

// 2. تخزين بيانات IP المزيف - محدث ومتوافق مع الإضافة
app.post('/get_ip.php', (req, res) => {
  let data = req.body;
  console.log('📤 POST /get_ip.php', data);

  // تحويل Object إلى Array إذا لزم الأمر (للتتوافق مع الإضافة)
  if (!Array.isArray(data)) {
    data = [data];
  }

  if (data.length === 0) {
    return res.status(400).json({ error: 'Invalid data format' });
  }

  const item = data[0];
  const { spoof_ip, user_id, transaction_id, liveness_id } = item || {};

  if (!user_id || !transaction_id || !spoof_ip) {
    return res.status(400).json({ 
      success: false,
      error: 'Missing required fields: user_id, transaction_id, spoof_ip' 
    });
  }

  // الحصول على IP العميل
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;

  db.run(
    `INSERT OR REPLACE INTO liveness_data 
     (user_id, transaction_id, liveness_id, spoof_ip, client_ip, status, created_at)
     VALUES (?, ?, ?, ?, ?, COALESCE((SELECT status FROM liveness_data WHERE user_id = ?), 'pending'), datetime('now'))`,
    [user_id, transaction_id, liveness_id, spoof_ip, clientIp, user_id],
    function(err) {
      if (err) {
        console.error('❌ Database error:', err);
        return res.status(500).json({ 
          success: false,
          error: err.message 
        });
      }
      
      console.log('✅ Data stored - ID:', this.lastID, 'user_id=', user_id);

      // تحديث الحالة إلى completed عند وجود liveness_id
      let finalStatus = 'pending';
      if (liveness_id) {
        db.run(
          `UPDATE liveness_data SET status = 'completed' WHERE user_id = ?`,
          [user_id],
          (updateErr) => {
            if (!updateErr) {
              console.log(`🎯 Marked user ${user_id} as completed`);
              finalStatus = 'completed';
            }
          }
        );
      }

      res.json({
        success: true,
        message: 'Spoof IP data stored successfully',
        id: this.lastID,
        status: finalStatus,
        user_id: user_id
      });
    }
  );
});

// 3. Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    server: 'liveness-bls-server',
    version: '2.1',
    timestamp: new Date().toISOString(),
    endpoints: {
      retrieve_data: 'GET /retrieve_data.php?user_id=USER_ID',
      store_spoof_ip: 'POST /get_ip.php',
      update_liveness: 'POST /update_liveness.php',
      user_status: 'GET /user_status.php?user_id=USER_ID'
    }
  });
});

// 4. تحديث نتائج التحقق (update_liveness.php)
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
        // إن لم يوجد سجل — أنشئه
        const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;
        db.run(
          `INSERT INTO liveness_data 
           (user_id, transaction_id, liveness_id, spoof_ip, client_ip, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'completed', datetime('now'))`,
          [user_id, transaction_id, liveness_id, spoof_ip, clientIp],
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

// 5. الحصول على حالة المستخدم
app.get('/user_status.php', (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ 
    success: false,
    error: 'user_id parameter is required' 
  });

  db.get(
    "SELECT user_id, transaction_id, spoof_ip, status, created_at FROM liveness_data WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
    [userId],
    (err, row) => {
      if (err) {
        console.error('❌ Database error:', err);
        return res.status(500).json({ 
          success: false,
          error: err.message 
        });
      }
      if (row) res.json({ success: true, data: row });
      else res.json({ 
        success: false, 
        message: 'لم يتم العثور على بيانات للمستخدم' 
      });
    }
  );
});

// 6. endpoint جديد متوافق تماماً مع الإضافة
app.post('/store_data.php', (req, res) => {
  const { spoof_ip, user_id, transaction_id, liveness_id } = req.body;
  console.log('📤 POST /store_data.php', req.body);

  if (!user_id || !transaction_id || !spoof_ip) {
    return res.status(400).json({ 
      success: false,
      error: 'Missing required fields: user_id, transaction_id, spoof_ip'
    });
  }

  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;

  db.run(
    `INSERT OR REPLACE INTO liveness_data 
     (user_id, transaction_id, liveness_id, spoof_ip, client_ip, status, created_at)
     VALUES (?, ?, ?, ?, ?, COALESCE((SELECT status FROM liveness_data WHERE user_id = ?), 'pending'), datetime('now'))`,
    [user_id, transaction_id, liveness_id, spoof_ip, clientIp, user_id],
    function(err) {
      if (err) {
        console.error('❌ Database error:', err);
        return res.status(500).json({ 
          success: false,
          error: err.message 
        });
      }

      let finalStatus = 'pending';
      if (liveness_id) {
        db.run(
          `UPDATE liveness_data SET status = 'completed' WHERE user_id = ?`,
          [user_id],
          (updateErr) => {
            if (!updateErr) {
              console.log(`🎯 Marked user ${user_id} as completed`);
              finalStatus = 'completed';
            }
          }
        );
      }

      res.json({
        success: true,
        message: 'Data stored successfully',
        id: this.lastID,
        status: finalStatus,
        user_id: user_id
      });
    }
  );
});

// 7. Temporary debug endpoint
app.get('/debug_all', (req, res) => {
  db.all("SELECT * FROM liveness_data ORDER BY created_at DESC LIMIT 500", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// تنظيف البيانات القديمة (كل ساعة)
setInterval(() => {
  db.run("DELETE FROM liveness_data WHERE created_at < datetime('now', '-2 hours')", (err) => {
    if (err) console.error('❌ Error cleaning old data:', err);
    else console.log('✅ Old data cleaned');
  });
}, 3600000);

// بدء الخادم
app.listen(PORT, () => {
  console.log(`🚀 Liveness BLS Server running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
  console.log(`📍 Local: http://localhost:${PORT}/`);
  console.log(`✅ Server is now compatible with the extension`);
});
