// server.js — الإصدار المعدل (بدون إنشاء تلقائي لـ transaction_id)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

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
    actions TEXT,
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
    version: '5.0',
    auto_create: false,
    note: 'Server does NOT auto-create transaction_id',
    timestamp: new Date().toISOString()
  });
});

// 1. استرجاع البيانات - لا ينشئ user_id تلقائياً
app.get('/retrieve_data.php', (req, res) => {
  const userId = req.query.user_id;
  console.log('📥 GET /retrieve_data.php?user_id=', userId);

  if (!userId) {
    return res.status(400).json({ error: 'user_id parameter is required' });
  }

  const cleanUserId = String(userId).trim();
  
  db.get("SELECT * FROM liveness_data WHERE user_id = ?", [cleanUserId], (err, row) => {
    if (err) {
      console.error('❌ Database error:', err);
      return res.status(500).json({ error: err.message });
    }

    // ❌ لا نقوم بإنشاء مستخدم تلقائياً
    if (!row) {
      console.log(`❌ User ${cleanUserId} not found in database`);
      return res.status(404).json({ 
        error: 'User not found', 
        user_id: cleanUserId,
        message: 'المستخدم غير موجود. يرجى إنشاء الجلسة أولاً عبر set_actions.php'
      });
    }

    const createdAt = new Date(row.created_at);
    const elapsedMinutes = (Date.now() - createdAt.getTime()) / 60000;

    if (row.status === 'completed') {
      console.log(`✅ ${cleanUserId} completed — stop polling.`);
      return res.json({ 
        stop: true, 
        status: 'completed',
        liveness_id: row.liveness_id,
        user_id: row.user_id,
        transaction_id: row.transaction_id,
        spoof_ip: row.spoof_ip,
        actions: row.actions ? JSON.parse(row.actions) : null
      });
    }

    if (elapsedMinutes > 5) {
      console.log(`⏰ Timeout reached for ${cleanUserId} (${elapsedMinutes.toFixed(1)} min).`);
      db.run(
        "UPDATE liveness_data SET status = 'timeout' WHERE user_id = ?",
        [cleanUserId]
      );
      return res.json({ 
        stop: true, 
        status: 'timeout',
        transaction_id: row.transaction_id,
        spoof_ip: row.spoof_ip,
        actions: row.actions ? JSON.parse(row.actions) : null
      });
    }

    console.log(`⏳ Still pending for ${cleanUserId} (${elapsedMinutes.toFixed(1)} min).`);
    return res.json({ 
      user_id: row.user_id, 
      status: row.status,
      liveness_id: row.liveness_id,
      transaction_id: row.transaction_id,
      spoof_ip: row.spoof_ip,
      actions: row.actions ? JSON.parse(row.actions) : null
    });
  });
});

// 2. تخزين بيانات IP المزيف والإجراءات (يأخذ transaction_id من المستخدم)
app.post('/get_ip.php', (req, res) => {
  const data = req.body;
  console.log('📤 POST /get_ip.php', data);

  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ error: 'Invalid data format' });
  }

  const item = data[0];
  const { spoof_ip, user_id, transaction_id, liveness_id, actions } = item || {};

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  if (!spoof_ip) {
    return res.status(400).json({ error: 'spoof_ip is required' });
  }

  // ✅ transaction_id مطلوب - لا نستخدم قيمة افتراضية
  if (!transaction_id || transaction_id === 'auto') {
    console.error(`❌ transaction_id is required for user ${user_id}`);
    return res.status(400).json({ 
      error: 'transaction_id is required',
      message: 'يجب إرسال transaction_id صالح'
    });
  }

  // ✅ الإجراءات مطلوبة - لا نستخدم قيماً افتراضية
  if (!actions || !Array.isArray(actions) || actions.length === 0) {
    console.error(`❌ No actions provided for user ${user_id}`);
    return res.status(400).json({ 
      error: 'actions array is required',
      message: 'يجب إرسال الإجراءات المطلوبة'
    });
  }

  const actionsJson = JSON.stringify(actions);
  console.log(`🎭 Actions received for ${user_id}:`, actions);
  console.log(`🆔 Transaction ID received:`, transaction_id);

  // ✅ تحديث أو إدراج record مع transaction_id من المستخدم
  db.run(
    `INSERT INTO liveness_data (user_id, transaction_id, liveness_id, spoof_ip, actions, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       transaction_id = excluded.transaction_id,
       liveness_id = COALESCE(excluded.liveness_id, liveness_id),
       spoof_ip = excluded.spoof_ip,
       actions = excluded.actions,
       status = 'pending',
       created_at = datetime('now')`,
    [user_id, transaction_id, liveness_id || null, spoof_ip, actionsJson],
    function(err) {
      if (err) {
        console.error('❌ Database error:', err);
        return res.status(500).json({ error: err.message });
      }
      
      console.log(`✅ Stored/Updated record for user: ${user_id} with transaction_id: ${transaction_id}`);
      res.json({
        success: true,
        message: 'Data stored successfully',
        user_id,
        transaction_id,
        liveness_id,
        actions: actions
      });
    }
  );
});

// 3. Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    server: 'liveness-bls.onrender.com',
    version: '5.0',
    auto_create: false,
    timestamp: new Date().toISOString()
  });
});

// 4. جلب الإجراءات للمستخدم
app.get('/get_actions.php', (req, res) => {
  const userId = req.query.user_id;
  console.log('📥 GET /get_actions.php?user_id=', userId);

  if (!userId) {
    return res.status(400).json({ error: 'user_id parameter is required' });
  }

  db.get("SELECT actions, transaction_id FROM liveness_data WHERE user_id = ?", [userId], (err, row) => {
    if (err) {
      console.error('❌ Database error:', err);
      return res.status(500).json({ error: err.message });
    }

    if (!row || !row.actions) {
      return res.status(404).json({
        success: false,
        error: 'No actions found for this user',
        user_id: userId,
        message: 'لم يتم العثور على إجراءات. يرجى إنشاء الجلسة أولاً عبر set_actions.php'
      });
    }

    try {
      const actions = JSON.parse(row.actions);
      res.json({ 
        success: true, 
        user_id: userId, 
        transaction_id: row.transaction_id,
        actions: actions 
      });
    } catch(e) {
      res.status(500).json({ error: 'Invalid actions format' });
    }
  });
});

// 5. تحديث liveness_id (يأخذ transaction_id من المستخدم)
app.post('/update_liveness_id', (req, res) => {
  console.log('📥 POST /update_liveness_id', req.body);
  
  const { user_id, liveness_id, transaction_id, spoof_ip } = req.body;

  if (!user_id) {
    return res.status(400).json({ success: false, error: 'user_id is required' });
  }

  if (!liveness_id) {
    return res.status(400).json({ success: false, error: 'liveness_id is required' });
  }

  // ✅ transaction_id مطلوب
  if (!transaction_id || transaction_id === 'auto') {
    console.error(`❌ transaction_id is required for user ${user_id}`);
    return res.status(400).json({ 
      success: false, 
      error: 'transaction_id is required'
    });
  }

  // التحقق من وجود المستخدم أولاً
  db.get("SELECT id FROM liveness_data WHERE user_id = ?", [user_id], (err, row) => {
    if (err) {
      console.error('❌ Database error:', err);
      return res.status(500).json({ success: false, error: err.message });
    }

    if (!row) {
      console.log(`❌ User ${user_id} not found in database`);
      return res.status(404).json({ 
        success: false, 
        error: 'User not found. Please create session first using set_actions.php',
        user_id: user_id
      });
    }

    // ✅ تحديث مع transaction_id الجديد
    db.run(
      `UPDATE liveness_data 
       SET liveness_id = ?, 
           transaction_id = ?,
           spoof_ip = COALESCE(?, spoof_ip),
           status = 'completed',
           created_at = datetime('now')
       WHERE user_id = ?`,
      [liveness_id, transaction_id, spoof_ip, user_id],
      function(err) {
        if (err) {
          console.error('❌ Failed to update liveness_id:', err);
          return res.status(500).json({ success: false, error: err.message });
        }
        
        console.log(`✅ Liveness ID ${liveness_id} stored for user ${user_id} with transaction_id ${transaction_id}`);
        
        res.json({ 
          success: true, 
          message: 'Liveness ID updated successfully',
          user_id: user_id,
          liveness_id: liveness_id,
          transaction_id: transaction_id,
          status: 'completed'
        });
      }
    );
  });
});

// 6. تعيين الإجراءات (للمسؤول) - لا ينشئ transaction_id تلقائياً
app.post('/set_actions.php', (req, res) => {
  const { user_id, actions, transaction_id } = req.body;
  console.log('📥 POST /set_actions.php', { user_id, actions, transaction_id });

  if (!user_id) {
    return res.status(400).json({ success: false, error: 'user_id is required' });
  }

  if (!actions || !Array.isArray(actions) || actions.length === 0) {
    return res.status(400).json({ success: false, error: 'actions array is required' });
  }

  // ✅ transaction_id مطلوب
  if (!transaction_id || transaction_id === 'auto') {
    console.error(`❌ transaction_id is required for user ${user_id}`);
    return res.status(400).json({ 
      success: false, 
      error: 'transaction_id is required',
      message: 'يجب إرسال transaction_id صالح'
    });
  }

  const actionsJson = JSON.stringify(actions);

  db.run(
    `INSERT INTO liveness_data (user_id, transaction_id, actions, status, created_at)
     VALUES (?, ?, ?, 'pending', datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       transaction_id = excluded.transaction_id,
       actions = excluded.actions,
       status = 'pending',
       created_at = datetime('now')`,
    [user_id, transaction_id, actionsJson],
    function(err) {
      if (err) {
        console.error('❌ Failed to set actions:', err);
        return res.status(500).json({ success: false, error: err.message });
      }
      
      console.log(`✅ Actions set for user ${user_id} with transaction_id ${transaction_id}:`, actions);
      res.json({ 
        success: true, 
        message: 'Actions set successfully',
        user_id: user_id,
        transaction_id: transaction_id,
        actions: actions
      });
    }
  );
});

// 7. عرض جميع البيانات (debug)
app.get('/debug_all', (req, res) => {
  db.all("SELECT * FROM liveness_data ORDER BY created_at DESC LIMIT 100", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const formattedRows = rows.map(row => {
      let actions = row.actions;
      try { actions = JSON.parse(actions); } catch(e) { }
      return { ...row, actions };
    });
    res.json(formattedRows);
  });
});

// 8. صفحة liveness.html
app.get('/liveness.html', (req, res) => {
  const userId = req.query.user_id;
  
  if (!userId) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><title>Error</title></head>
      <body style="font-family:Arial;text-align:center;padding:50px;">
        <h1>❌ Error</h1>
        <p>Missing user_id parameter</p>
      </body>
      </html>
    `);
  }

  res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Liveness Verification</title>
    <style>
        body { font-family: Arial; text-align: center; padding: 50px; background: #1a1a1a; color: white; }
        .container { max-width: 500px; margin: 0 auto; background: #2d2d2d; padding: 30px; border-radius: 15px; }
        .spinner { width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid #28a745; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
    <script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>
</head>
<body>
    <div class="container">
        <h1>📸 Liveness Verification</h1>
        <p>User ID: ${userId}</p>
        <div class="spinner" id="spinner"></div>
        <div id="status">🔄 Loading...</div>
    </div>
    <script>
        const userId = "${userId}";
        const UPDATE_URL = "https://liveness-bls.onrender.com/update_liveness_id";
        const GET_DATA_URL = "https://liveness-bls.onrender.com/retrieve_data.php?user_id=" + userId;
        
        async function getData() {
            try {
                const response = await fetch(GET_DATA_URL);
                if (response.status === 404) {
                    document.getElementById('status').innerHTML = '⏳ Waiting for session...';
                    setTimeout(getData, 3000);
                    return;
                }
                const data = await response.json();
                if (data.actions && data.transaction_id) {
                    startLiveness(data.actions, data.transaction_id);
                } else {
                    setTimeout(getData, 3000);
                }
            } catch(e) {
                setTimeout(getData, 3000);
            }
        }
        
        function startLiveness(actions, transactionId) {
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('status').innerHTML = '🎥 Starting camera...';
            
            OzLiveness.open({
                lang: 'en',
                meta: { 
                    user_id: userId, 
                    transaction_id: transactionId
                },
                action: actions,
                on_complete: async (result) => {
                    if (result?.event_session_id) {
                        await fetch(UPDATE_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                user_id: userId, 
                                liveness_id: result.event_session_id,
                                transaction_id: transactionId
                            })
                        });
                        document.getElementById('status').innerHTML = '✅ Verification complete!';
                        setTimeout(() => window.close(), 2000);
                    }
                },
                on_error: (err) => {
                    document.getElementById('status').innerHTML = '❌ Error: ' + JSON.stringify(err);
                }
            });
        }
        
        getData();
    </script>
</body>
</html>
  `);
});

// 9. اختبار قاعدة البيانات
app.get('/test-db', (req, res) => {
  db.get("SELECT COUNT(*) as count FROM liveness_data", [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, recordCount: row.count, timestamp: Date.now() });
  });
});

// تنظيف تلقائي
setInterval(() => {
  db.run("DELETE FROM liveness_data WHERE created_at < datetime('now', '-2 hours')", (err) => {
    if (!err) console.log('🧹 Cleaned old data');
  });
}, 300000);

// بدء الخادم
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`❌ Auto-create users: DISABLED`);
  console.log(`✅ Server uses transaction_id from client ONLY`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
});
