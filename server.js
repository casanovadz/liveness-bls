// server.js — الإصدار مع إنشاء تلقائي للمستخدم (بدون قيم افتراضية للإجراءات)
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
    version: '4.0',
    auto_create: true,
    timestamp: new Date().toISOString()
  });
});

// 1. استرجاع البيانات (GET) - ✅ ينشئ المستخدم تلقائياً إذا لم يكن موجوداً
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

    // ✅ إذا لم يتم العثور على المستخدم، نقوم بإنشائه تلقائياً
    if (!row) {
      const newTransactionId = crypto.randomUUID ? crypto.randomUUID() : ('tx-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8));
      // ✅ لا نضع إجراءات افتراضية - نتركها فارغة
      db.run(
        `INSERT INTO liveness_data (user_id, transaction_id, liveness_id, spoof_ip, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
        [cleanUserId, newTransactionId, 'lv-auto', '0.0.0.0'],
        function (insertErr) {
          if (insertErr) {
            console.error('❌ Insert error:', insertErr);
            return res.status(500).json({ error: insertErr.message });
          }
          console.log(`🆕 Auto-created user: ${cleanUserId} with transaction: ${newTransactionId}`);
          return res.json({ 
            user_id: cleanUserId, 
            status: 'pending',
            transaction_id: newTransactionId,
            liveness_id: 'lv-auto',
            spoof_ip: '0.0.0.0',
            actions: null,  // ✅ لا توجد إجراءات حتى يقوم المسؤول بتعيينها
            message: 'User created. Waiting for admin to set actions.'
          });
        }
      );
      return;
    }

    // المستخدم موجود - نعيد بياناته
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

// 2. تخزين أو تحديث بيانات IP المزيف والإجراءات
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

  db.get("SELECT id FROM liveness_data WHERE user_id = ?", [user_id], (err, row) => {
    if (err) {
      console.error('❌ Database error:', err);
      return res.status(500).json({ error: err.message });
    }

    if (row) {
      db.run(
        `UPDATE liveness_data
         SET transaction_id = COALESCE(?, transaction_id),
             liveness_id = COALESCE(?, liveness_id),
             spoof_ip = ?,
             actions = ?,
             status = 'updated',
             created_at = datetime('now')
         WHERE user_id = ?`,
        [transaction_id, liveness_id, spoof_ip, actionsJson, user_id],
        function (updateErr) {
          if (updateErr) {
            console.error('❌ Update error:', updateErr);
            return res.status(500).json({ error: updateErr.message });
          }
          console.log(`🔄 Updated record for user: ${user_id} with actions: ${actionsJson}`);
          res.json({
            success: true,
            message: 'Data updated successfully',
            user_id,
            transaction_id,
            liveness_id,
            actions: actions
          });
        }
      );
    } else {
      db.run(
        `INSERT INTO liveness_data (user_id, transaction_id, liveness_id, spoof_ip, actions, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
        [user_id, transaction_id || 'auto', liveness_id || null, spoof_ip, actionsJson],
        function (insertErr) {
          if (insertErr) {
            console.error('❌ Insert error:', insertErr);
            return res.status(500).json({ error: insertErr.message });
          }
          console.log('✅ New data stored - ID:', this.lastID);
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
    }
  });
});

// 3. Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    server: 'liveness-bls.onrender.com',
    version: '4.0',
    auto_create: true,
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

  db.get("SELECT actions FROM liveness_data WHERE user_id = ?", [userId], (err, row) => {
    if (err) {
      console.error('❌ Database error:', err);
      return res.status(500).json({ error: err.message });
    }

    if (!row || !row.actions) {
      return res.status(404).json({
        success: false,
        error: 'No actions found for this user',
        user_id: userId,
        message: 'لم يتم العثور على إجراءات. يرجى انتظار المسؤول.'
      });
    }

    try {
      const actions = JSON.parse(row.actions);
      res.json({ success: true, user_id: userId, actions: actions });
    } catch(e) {
      res.status(500).json({ error: 'Invalid actions format' });
    }
  });
});

// 5. تحديث liveness_id بعد اكتمال التحقق
app.post('/update_liveness_id', (req, res) => {
  console.log('📥 POST /update_liveness_id', req.body);
  
  const { user_id, liveness_id, transaction_id, spoof_ip } = req.body;

  if (!user_id || !liveness_id) {
    return res.status(400).json({ success: false, error: 'user_id and liveness_id required' });
  }

  db.run(
    `UPDATE liveness_data 
     SET liveness_id = ?, 
         status = 'completed',
         transaction_id = COALESCE(?, transaction_id),
         spoof_ip = COALESCE(?, spoof_ip)
     WHERE user_id = ?`,
    [liveness_id, transaction_id, spoof_ip, user_id],
    function(err) {
      if (err) {
        console.error('❌ Update error:', err);
        return res.status(500).json({ success: false, error: err.message });
      }
      
      console.log(`✅ Liveness ID ${liveness_id} stored for user ${user_id}`);
      res.json({ success: true, message: 'Liveness ID updated', status: 'completed' });
    }
  );
});

// 6. تعيين الإجراءات (للمسؤول)
app.post('/set_actions.php', (req, res) => {
  const { user_id, actions } = req.body;
  console.log('📥 POST /set_actions.php', { user_id, actions });

  if (!user_id) {
    return res.status(400).json({ success: false, error: 'user_id is required' });
  }

  if (!actions || !Array.isArray(actions) || actions.length === 0) {
    return res.status(400).json({ success: false, error: 'actions array is required' });
  }

  const actionsJson = JSON.stringify(actions);

  db.run(
    `INSERT INTO liveness_data (user_id, actions, status, created_at)
     VALUES (?, ?, 'pending', datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       actions = excluded.actions,
       status = 'pending',
       created_at = datetime('now')`,
    [user_id, actionsJson],
    function(err) {
      if (err) {
        console.error('❌ Failed to set actions:', err);
        return res.status(500).json({ success: false, error: err.message });
      }
      
      console.log(`✅ Actions set for user ${user_id}:`, actions);
      res.json({ success: true, message: 'Actions set successfully', user_id, actions });
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
        .status { margin-top: 20px; padding: 10px; border-radius: 8px; }
    </style>
    <script src="https://web-sdk.prod.cdn.spain.ozforensics.com/blsinternational/plugin_liveness.php"></script>
</head>
<body>
    <div class="container">
        <h1>📸 Liveness Verification</h1>
        <p>User ID: ${userId || 'Not specified'}</p>
        <div class="spinner" id="spinner"></div>
        <div class="status" id="status">🔄 Loading actions from server...</div>
    </div>
    <script>
        const userId = "${userId || ''}";
        const UPDATE_URL = "https://liveness-bls.onrender.com/update_liveness_id";
        const GET_ACTIONS_URL = "https://liveness-bls.onrender.com/get_actions.php?user_id=" + userId;
        
        async function fetchActions() {
            try {
                const response = await fetch(GET_ACTIONS_URL);
                if (response.status === 404) {
                    document.getElementById('status').innerHTML = '⏳ Waiting for admin to configure...';
                    setTimeout(fetchActions, 3000);
                    return;
                }
                const data = await response.json();
                if (data.success && data.actions) {
                    startLiveness(data.actions);
                } else {
                    setTimeout(fetchActions, 3000);
                }
            } catch(e) {
                setTimeout(fetchActions, 3000);
            }
        }
        
        function startLiveness(actions) {
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('status').innerHTML = '🎥 Starting camera...';
            
            OzLiveness.open({
                lang: 'en',
                meta: { user_id: userId, transaction_id: 'liveness-' + Date.now() },
                action: actions,
                on_complete: async (result) => {
                    if (result?.event_session_id) {
                        await fetch(UPDATE_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ user_id: userId, liveness_id: result.event_session_id })
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
        
        fetchActions();
    </script>
</body>
</html>
  `);
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
  console.log(`✅ Auto-create users: ENABLED`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
});
