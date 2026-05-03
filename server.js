// server.js — الإصدار النهائي الكامل (محسّن للسرعة مع جميع الوظائف)
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware محسّن للسرعة ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

const allowedHeaders = [
  'Content-Type',
  'Authorization',
  'Cache-Control',
  'Accept',
  'X-Requested-With'
];

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
  allowedHeaders: allowedHeaders,
  credentials: true,
  maxAge: 86400
}));

app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE');
  res.header('Access-Control-Allow-Headers', allowedHeaders.join(', '));
  res.header('Access-Control-Max-Age', '86400');
  return res.sendStatus(204);
});

// ---------- قاعدة بيانات محسّنة ----------
const dbPath = path.join(__dirname, 'liveness.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('❌ Error opening database:', err);
  else console.log('✅ Connected to SQLite database');
});

// تحسين أداء قاعدة البيانات
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");
db.run("PRAGMA cache_size = 10000");
db.run("PRAGMA temp_store = MEMORY");

db.serialize(() => {
  // إنشاء الجدول مع إضافة عمود actions
  db.run(`CREATE TABLE IF NOT EXISTS liveness_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE,
    transaction_id TEXT,
    liveness_id TEXT,
    spoof_ip TEXT,
    client_ip TEXT,
    actions TEXT DEFAULT '["video_selfie_scan","video_selfie_smile","video_selfie_blink"]',
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error('❌ Error creating table:', err);
    else console.log('✅ Table ready');
  });

  // إضافة عمود actions إذا كان غير موجود (للقواعد القديمة)
  db.run(`ALTER TABLE liveness_data ADD COLUMN actions TEXT DEFAULT '["video_selfie_scan","video_selfie_smile","video_selfie_blink"]'`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // العمود موجود بالفعل أو خطأ آخر غير التكرار
    } else if (!err) {
      console.log('✅ Actions column added');
    }
  });

  // إضافة فهارس لتسريع البحث
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_id ON liveness_data(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_status ON liveness_data(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON liveness_data(created_at)`);
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

// 1. استرجاع البيانات أو إنشاؤها تلقائيًا (مع إيقاف بعد 5 دقائق أو اكتمال العملية)
app.get('/retrieve_data.php', (req, res) => {
  const userId = req.query.user_id;
  console.log('📥 GET /retrieve_data.php?user_id=', userId);

  if (!userId) {
    return res.status(400).json({ error: 'user_id parameter is required' });
  }

  db.get("SELECT * FROM liveness_data WHERE user_id = ?", [userId], (err, row) => {
    if (err) {
      console.error('❌ Database error:', err);
      return res.status(500).json({ error: err.message });
    }

    // لو لم توجد بيانات، أنشئ سجل جديد بحالة pending
    if (!row) {
      db.run(
        `INSERT INTO liveness_data (user_id, transaction_id, liveness_id, spoof_ip, actions, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [userId, 'tx-auto', 'lv-auto', '0.0.0.0', '["video_selfie_scan","video_selfie_smile","video_selfie_blink"]', 'pending'],
        function (insertErr) {
          if (insertErr) {
            console.error('❌ Insert error:', insertErr);
            return res.status(500).json({ error: insertErr.message });
          }
          console.log(`🆕 Created new pending record for user_id: ${userId}`);
          return res.json([{ user_id: userId, status: 'pending' }]);
        }
      );
      return;
    }

    // حساب المدة منذ الإنشاء
    const createdAt = new Date(row.created_at);
    const elapsedMinutes = (Date.now() - createdAt.getTime()) / 60000;

    // إذا كانت العملية مكتملة — أوقف polling نهائيًا
    if (row.status === 'completed') {
      console.log(`✅ ${userId} completed — stop polling.`);
      return res.json({ stop: true, status: 'completed' });
    }

    // إذا تجاوزت المدة 5 دقائق — أوقف polling أيضًا
    if (elapsedMinutes > 5) {
      console.log(`⏰ Timeout reached for ${userId} (${elapsedMinutes.toFixed(1)} min).`);
      db.run(
        "UPDATE liveness_data SET status = 'timeout' WHERE user_id = ?",
        [userId]
      );
      return res.json({ stop: true, status: 'timeout' });
    }

    // إذا ما زالت العملية جارية
    console.log(`⏳ Still pending for ${userId} (${elapsedMinutes.toFixed(1)} min).`);
    return res.json([{ user_id: row.user_id, status: row.status }]);
  });
});


// 2. تخزين أو تحديث بيانات IP المزيف + إرجاع رابط مباشر للعميل (مع دعم actions و force_new)
app.post('/get_ip.php', (req, res) => {
  const data = req.body;
  console.log('📤 POST /get_ip.php', data);

  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ error: 'Invalid data format' });
  }

  const item = data[0];
  const { spoof_ip, user_id, transaction_id, liveness_id, actions, force_new } = item || {};

  if (!user_id || !transaction_id || !spoof_ip) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // استخدام الإجراءات المرسلة أو الإجراءات الافتراضية (مع حركات الرأس)
  let finalActions = actions;
  if (!finalActions || !Array.isArray(finalActions) || finalActions.length === 0) {
    finalActions = ["video_selfie_scan", "video_selfie_smile", "video_selfie_blink"];
  }
  const actionsJson = JSON.stringify(finalActions);
  console.log(`🎭 Actions for ${user_id}:`, finalActions);
  console.log(`🔄 Force new: ${force_new ? 'YES' : 'NO'}`);

  const selfieLink = `https://algeria.blsspainglobal.com/assets/images/logo.png?user_id=${encodeURIComponent(user_id)}`;

  // إذا كان force_new = true، احذف السجل القديم أولاً
  if (force_new === true) {
    db.run("DELETE FROM liveness_data WHERE user_id = ?", [user_id], function(deleteErr) {
      if (deleteErr) {
        console.error('❌ Error deleting old record:', deleteErr);
      } else {
        console.log(`🗑️ Deleted old record for user_id: ${user_id}`);
      }
      createNewRecord();
    });
  } else {
    db.get("SELECT id FROM liveness_data WHERE user_id = ?", [user_id], (err, row) => {
      if (err) {
        console.error('❌ Database error:', err);
        return res.status(500).json({ error: err.message });
      }
      
      if (row) {
        updateExistingRecord();
      } else {
        createNewRecord();
      }
    });
  }

  function createNewRecord() {
    db.run(
      `INSERT INTO liveness_data (user_id, transaction_id, liveness_id, spoof_ip, actions, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
      [user_id, transaction_id, liveness_id, spoof_ip, actionsJson],
      function (insertErr) {
        if (insertErr) {
          console.error('❌ Insert error:', insertErr);
          return res.status(500).json({ error: insertErr.message });
        }
        console.log('✅ New data stored - ID:', this.lastID, 'user_id=', user_id, 'actions:', actionsJson);
        res.json({
          success: true,
          message: 'Spoof IP data stored successfully',
          user_id,
          transaction_id,
          liveness_id,
          actions: finalActions,
          link: selfieLink
        });
      }
    );
  }

  function updateExistingRecord() {
    db.run(
      `UPDATE liveness_data
       SET transaction_id = ?, liveness_id = ?, spoof_ip = ?, actions = ?, status = 'updated', created_at = datetime('now')
       WHERE user_id = ?`,
      [transaction_id, liveness_id, spoof_ip, actionsJson, user_id],
      function (updateErr) {
        if (updateErr) {
          console.error('❌ Update error:', updateErr);
          return res.status(500).json({ error: updateErr.message });
        }
        console.log(`🔄 Updated record for user_id: ${user_id} with actions: ${actionsJson}`);
        res.json({
          success: true,
          message: 'Spoof IP data updated successfully',
          user_id,
          transaction_id,
          liveness_id,
          actions: finalActions,
          link: selfieLink
        });
      }
    );
  }
});


// 3. Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    server: 'liveness-bls.uk',
    version: '2.3',
    timestamp: new Date().toISOString(),
    endpoints: {
      retrieve_data: 'GET /retrieve_data.php?user_id=USER_ID',
      store_spoof_ip: 'POST /get_ip.php',
      get_actions: 'GET /get_actions.php?user_id=USER_ID',
      update_liveness: 'POST /update_liveness.php',
      reset_user_data: 'POST /reset_user_data.php',
      user_status: 'GET /user_status.php?user_id=USER_ID',
      debug_all: 'GET /debug_all'
    }
  });
});

// 3.5 جلب الإجراءات المطلوبة للمستخدم
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

    let actions = ["video_selfie_scan", "video_selfie_smile", "video_selfie_blink"];
    if (row && row.actions) {
      try {
        actions = JSON.parse(row.actions);
        console.log(`✅ Actions retrieved for ${userId}:`, actions);
      } catch(e) {
        console.error('Error parsing actions:', e);
      }
    } else {
      console.log(`ℹ️ No actions found for ${userId}, using defaults`);
    }

    res.json({
      success: true,
      user_id: userId,
      actions: actions
    });
  });
});

// 3.6 حذف بيانات المستخدم (لإعادة التعيين)
app.post('/reset_user_data.php', (req, res) => {
  const { user_id } = req.body;
  console.log('🗑️ POST /reset_user_data.php for user:', user_id);

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  db.run("DELETE FROM liveness_data WHERE user_id = ?", [user_id], function(err) {
    if (err) {
      console.error('❌ Error deleting user data:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log(`✅ Deleted data for user: ${user_id} (changes: ${this.changes})`);
    res.json({ 
      success: true, 
      message: `Data for user ${user_id} has been reset`,
      deleted: this.changes
    });
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
    "SELECT user_id, transaction_id, spoof_ip, actions, status, created_at FROM liveness_data WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
    [userId],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (row) {
        let actions = row.actions;
        try { actions = JSON.parse(actions); } catch(e) { /* keep as is */ }
        res.json({ success: true, data: { ...row, actions } });
      } else {
        res.json({ success: false, message: 'لم يتم العثور على بيانات للمستخدم' });
      }
    }
  );
});

// 6. Debug endpoint
app.get('/debug_all', (req, res) => {
  db.all("SELECT * FROM liveness_data ORDER BY created_at DESC LIMIT 500", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const formattedRows = rows.map(row => {
      let actions = row.actions;
      try { actions = JSON.parse(actions); } catch(e) { /* keep as is */ }
      return { ...row, actions };
    });
    res.json(formattedRows);
  });
});

// ---------- تنظيف تلقائي ----------
setInterval(() => {
  db.run("DELETE FROM liveness_data WHERE created_at < datetime('now', '-2 hours')", (err) => {
    if (err) console.error('❌ Error cleaning old data:', err);
    else console.log('🧹 Deleted old (>2h) data');
  });

  db.run("DELETE FROM liveness_data WHERE status = 'pending' AND created_at < datetime('now', '-10 minutes')", (err) => {
    if (err) console.error('❌ Error cleaning pending data:', err);
    else console.log('🕒 Removed stale pending records (>10min old)');
  });
}, 300000);

// ---------- بدء الخادم ----------
app.listen(PORT, () => {
  console.log(`🚀 Liveness BLS Server running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
});
