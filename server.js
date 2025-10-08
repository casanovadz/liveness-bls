// server.js — الإصدار النهائي (مع تنظيف السجلات pending بعد 10 دقائق)
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

const allowedHeaders = [
  'Content-Type',
  'Authorization',
  'Cache-Control',
  'Accept',
  'X-Requested-With'
];

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: allowedHeaders,
  credentials: true
}));

app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', allowedHeaders.join(', '));
  return res.sendStatus(200);
});

// ---------- قاعدة البيانات ----------
const dbPath = path.join(__dirname, 'liveness.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('❌ Error opening database:', err);
  else console.log('✅ Connected to SQLite database');
});

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

// 0. الصفحة الرئيسية
app.get('/', (req, res) => {
  res.json({
    message: 'Liveness BLS Server is running',
    status: 'OK',
    timestamp: new Date().toISOString()
  });
});

// 1. استرجاع البيانات أو إنشاؤها تلقائيًا
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

    if (rows.length === 0) {
      db.run(
        `INSERT INTO liveness_data (user_id, transaction_id, liveness_id, spoof_ip, status, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [userId, 'tx-auto', 'lv-auto', '0.0.0.0', 'pending'],
        function (insertErr) {
          if (insertErr) {
            console.error('❌ Insert error:', insertErr);
            return res.status(500).json({ error: insertErr.message });
          }
          console.log(`🆕 Created new pending record for user_id: ${userId}`);
          db.all("SELECT * FROM liveness_data WHERE user_id = ?", [userId], (e2, newRows) => {
            if (e2) return res.status(500).json({ error: e2.message });
            res.json(newRows);
          });
        }
      );
    } else {
      console.log('✅ Data retrieved:', rows.length, 'records for', userId);
      res.json(rows);
    }
  });
});

// 2. تخزين أو تحديث بيانات IP المزيف
app.post('/get_ip.php', (req, res) => {
  const data = req.body;
  console.log('📤 POST /get_ip.php', data);

  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ error: 'Invalid data format' });
  }

  const item = data[0];
  const { spoof_ip, user_id, transaction_id, liveness_id } = item || {};

  if (!user_id || !transaction_id || !spoof_ip) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  db.get("SELECT id FROM liveness_data WHERE user_id = ?", [user_id], (err, row) => {
    if (err) {
      console.error('❌ Database error:', err);
      return res.status(500).json({ error: err.message });
    }

    if (row) {
      db.run(
        `UPDATE liveness_data
         SET transaction_id = ?, liveness_id = ?, spoof_ip = ?, status = 'updated', created_at = datetime('now')
         WHERE user_id = ?`,
        [transaction_id, liveness_id, spoof_ip, user_id],
        function (updateErr) {
          if (updateErr) {
            console.error('❌ Update error:', updateErr);
            return res.status(500).json({ error: updateErr.message });
          }
          console.log(`🔄 Updated record for user_id: ${user_id}`);
          res.json({ success: true, message: 'Spoof IP data updated successfully', id: row.id });
        }
      );
    } else {
      db.run(
        `INSERT INTO liveness_data (user_id, transaction_id, liveness_id, spoof_ip, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
        [user_id, transaction_id, liveness_id, spoof_ip],
        function (insertErr) {
          if (insertErr) {
            console.error('❌ Insert error:', insertErr);
            return res.status(500).json({ error: insertErr.message });
          }
          console.log('✅ New data stored - ID:', this.lastID, 'user_id=', user_id);
          res.json({ success: true, message: 'Spoof IP data stored successfully', id: this.lastID });
        }
      );
    }
  });
});

// 3. Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    server: 'liveness-bls.uk',
    version: '2.1',
    timestamp: new Date().toISOString(),
    endpoints: {
      retrieve_data: 'GET /retrieve_data.php?user_id=USER_ID',
      store_spoof_ip: 'POST /get_ip.php'
    }
  });
});

// 4. تحديث نتائج التحقق
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
    function (err) {
      if (err) {
        console.error('❌ Database error:', err);
        return res.status(500).json({ success: false, message: err.message });
      }

      if (this.changes === 0) {
        db.run(
          `INSERT INTO liveness_data (user_id, transaction_id, liveness_id, spoof_ip, status, created_at)
           VALUES (?, ?, ?, ?, 'completed', datetime('now'))`,
          [user_id, transaction_id, liveness_id, spoof_ip],
          function (insertErr) {
            if (insertErr) {
              console.error('❌ Insert error:', insertErr);
              return res.status(500).json({ success: false, message: insertErr.message });
            }
            console.log('✅ New record created - ID:', this.lastID);
            res.json({ success: true, message: 'تم حفظ نتائج التحقق بنجاح', id: this.lastID, status: 'completed' });
          }
        );
      } else {
        console.log('✅ Liveness results updated - changes:', this.changes);
        res.json({ success: true, message: 'تم تحديث نتائج التحقق بنجاح', changes: this.changes, status: 'completed' });
      }
    }
  );
});

// 5. حالة المستخدم
app.get('/user_status.php', (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id parameter is required' });

  db.get(
    "SELECT user_id, transaction_id, spoof_ip, status, created_at FROM liveness_data WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
    [userId],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (row) res.json({ success: true, data: row });
      else res.json({ success: false, message: 'لم يتم العثور على بيانات للمستخدم' });
    }
  );
});

// 6. Debug endpoint
app.get('/debug_all', (req, res) => {
  db.all("SELECT * FROM liveness_data ORDER BY created_at DESC LIMIT 500", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ---------- تنظيف تلقائي ----------
setInterval(() => {
  // حذف كل السجلات الأقدم من ساعتين
  db.run("DELETE FROM liveness_data WHERE created_at < datetime('now', '-2 hours')", (err) => {
    if (err) console.error('❌ Error cleaning old data:', err);
    else console.log('🧹 Deleted old (>2h) data');
  });

  // حذف السجلات التي حالتها pending منذ أكثر من 10 دقائق
  db.run("DELETE FROM liveness_data WHERE status = 'pending' AND created_at < datetime('now', '-10 minutes')", (err) => {
    if (err) console.error('❌ Error cleaning pending data:', err);
    else console.log('🕒 Removed stale pending records (>10min old)');
  });
}, 300000); // كل 5 دقائق

// ---------- بدء الخادم ----------
app.listen(PORT, () => {
  console.log(`🚀 Liveness BLS Server running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
});
