// server.js (محدَّث)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- CORS & Body parsing ----------
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Accept', 'X-Requested-With'],
  credentials: true
}));

// Allow preflight for all routes
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Accept, X-Requested-With');
  return res.sendStatus(200);
});

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// (kept bodyParser for compatibility if you prefer)
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ---------- Simple request logging middleware ----------
const lastRequests = []; // in-memory store of last requests for debugging (keeps last 20)

app.use((req, res, next) => {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl || req.url,
      query: req.query || {},
      body: req.body || {},
      headers: {
        // limit header output to a few keys for readability
        origin: req.headers.origin,
        'user-agent': req.headers['user-agent'],
        'content-type': req.headers['content-type'],
        'cache-control': req.headers['cache-control']
      }
    };
    // push to memory (keep last 20)
    lastRequests.unshift(entry);
    if (lastRequests.length > 20) lastRequests.pop();

    // console log compactly
    console.log(`[${entry.timestamp}] ${entry.method} ${entry.path} — query=${JSON.stringify(entry.query)} body=${JSON.stringify(entry.body)}`);
  } catch (e) {
    console.error('Logging middleware error:', e);
  }
  next();
});

// ---------- SQLite DB ----------
const dbPath = path.join(__dirname, 'liveness.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Error opening database:', err);
  } else {
    console.log('✅ Connected to SQLite database:', dbPath);
  }
});

// create table if not exists
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS liveness_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
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
      console.log('✅ Table ready: liveness_data');
    }
  });
});

// ---------- Endpoints ----------

// GET /retrieve_data.php?user_id=...
app.get('/retrieve_data.php', (req, res) => {
  const userId = req.query.user_id;
  console.log('📥 GET /retrieve_data.php?user_id=', userId);

  if (!userId) {
    return res.status(400).json({ error: 'user_id parameter is required' });
  }

  db.all("SELECT * FROM liveness_data WHERE user_id = ? ORDER BY created_at DESC", [userId], (err, rows) => {
    if (err) {
      console.error('❌ Database error:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log(`✅ Data retrieved for user_id=${userId}: ${rows.length} rows`);
    res.json(rows);
  });
});

// POST /get_ip.php  (accepts array or object)
app.post('/get_ip.php', (req, res) => {
  let data = req.body;
  const client_ip =
    (req.headers['x-forwarded-for'] || '').split(',').shift() ||
    req.socket?.remoteAddress ||
    'unknown';

  console.log('📤 POST /get_ip.php raw body:', data, ' | Detected client_ip:', client_ip);

  // Accept both JSON array [ {...} ] or single object { ... }
  if (!data) {
    return res.status(400).json({ error: 'Invalid data format' });
  }
  if (!Array.isArray(data)) {
    if (typeof data === 'object') {
      data = [data];
    } else {
      return res.status(400).json({ error: 'Invalid data format' });
    }
  }

  if (data.length === 0) {
    return res.status(400).json({ error: 'Invalid data format: empty array' });
  }

  const entry = data[0];
  const { spoof_ip, user_id, transaction_id, liveness_id } = entry;

  if (!user_id || !transaction_id || !spoof_ip) {
    return res.status(400).json({ error: 'Missing required fields (user_id, transaction_id, spoof_ip)' });
  }

  db.run(
    `INSERT OR REPLACE INTO liveness_data (user_id, transaction_id, liveness_id, spoof_ip, client_ip, status)
     VALUES (?, ?, ?, ?, ?, COALESCE((SELECT status FROM liveness_data WHERE user_id = ? AND transaction_id = ?), 'pending'))`,
    [user_id, transaction_id, liveness_id, spoof_ip, client_ip, user_id, transaction_id],
    function (err) {
      if (err) {
        console.error('❌ Database error (insert):', err);
        return res.status(500).json({ error: err.message });
      }
      console.log('✅ Data stored - ID:', this.lastID, ' user_id=', user_id, ' spoof_ip=', spoof_ip, ' client_ip=', client_ip);
      res.json({
        success: true,
        message: 'Spoof IP data stored successfully',
        id: this.lastID,
        client_ip
      });
    }
  );
});

// POST /update_liveness.php
app.post('/update_liveness.php', (req, res) => {
  const { user_id, liveness_id, spoof_ip, transaction_id } = req.body || {};

  console.log('📥 POST /update_liveness.php body=', req.body);

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
        console.error('❌ Database error (update):', err);
        return res.status(500).json({
          success: false,
          message: 'خطأ في قاعدة البيانات: ' + err.message
        });
      }

      if (this.changes === 0) {
        // insert new if none updated
        db.run(
          `INSERT INTO liveness_data (user_id, transaction_id, liveness_id, spoof_ip, status) VALUES (?, ?, ?, ?, 'completed')`,
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

// GET /user_status.php?user_id=...
app.get('/user_status.php', (req, res) => {
  const userId = req.query.user_id;

  if (!userId) {
    return res.status(400).json({ error: 'user_id parameter is required' });
  }

  db.get(
    `SELECT user_id, transaction_id, spoof_ip, status, created_at 
     FROM liveness_data 
     WHERE user_id = ? 
     ORDER BY created_at DESC 
     LIMIT 1`,
    [userId],
    (err, row) => {
      if (err) {
        console.error('❌ Database error:', err);
        return res.status(500).json({ error: err.message });
      }

      if (row) {
        res.json({ success: true, data: row });
      } else {
        res.json({ success: false, message: 'لم يتم العثور على بيانات للمستخدم' });
      }
    }
  );
});

// Health & root
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    server: 'liveness-bls.uk',
    version: '2.0',
    timestamp: new Date().toISOString(),
    endpoints: {
      retrieve_data: 'GET /retrieve_data.php?user_id=USER_ID',
      store_spoof_ip: 'POST /get_ip.php'
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

// Debug endpoint: last in-memory requests
app.get('/debug_last', (req, res) => {
  res.json({
    success: true,
    count: lastRequests.length,
    lastRequests
  });
});

// Periodic cleanup (every hour) — optional
setInterval(() => {
  db.run("DELETE FROM liveness_data WHERE created_at < datetime('now', '-2 hours')", (err) => {
    if (err) {
      console.error('❌ Error cleaning old data:', err);
    } else {
      console.log('✅ Old data cleaned');
    }
  });
}, 3600000);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Liveness BLS Server running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
  console.log(`📍 Debug last requests: http://localhost:${PORT}/debug_last`);
});
