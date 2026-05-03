// server.js — الإصدار النهائي (مع دعم actions لحركات الرأس)
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
  // إنشاء الجدول مع إضافة عمود actions
  db.run(`CREATE TABLE IF NOT EXISTS liveness_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE,
    transaction_id TEXT,
    liveness_id TEXT,
    spoof_ip TEXT,
    client_ip TEXT,
    actions TEXT DEFAULT '["video_selfie_blank"]',
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) console.error('❌ Error creating table:', err);
    else console.log('✅ Table ready');
  });

  // إضافة عمود actions إذا كان غير موجود (للقواعد القديمة)
  db.run(`ALTER TABLE liveness_data ADD COLUMN actions TEXT DEFAULT '["video_selfie_blank"]'`, (err) => {
    if (err && !err.message.includes('duplicate column')) {
      // العمود موجود بالفعل أو خطأ آخر غير التكرار
    } else if (!err) {
      console.log('✅ Actions column added');
    }
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

    // 🆕 لو لم توجد بيانات، أنشئ سجل جديد بحالة pending
    if (!row) {
      db.run(
        `INSERT INTO liveness_data (user_id, transaction_id, liveness_id, spoof_ip, actions, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [userId, 'tx-auto', 'lv-auto', '0.0.0.0', '["video_selfie_blank"]', 'pending'],
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

    // 🕒 حساب المدة منذ الإنشاء
    const createdAt = new Date(row.created_at);
    const elapsedMinutes = (Date.now() - createdAt.getTime()) / 60000;

    // ✅ إذا كانت العملية مكتملة — أوقف polling نهائيًا
    if (row.status === 'completed') {
      console.log(`✅ ${userId} completed — stop polling.`);
      return res.json({ 
        stop: true, 
        status: 'completed',
        liveness_id: row.liveness_id,
        user_id: row.user_id
      });
    }

    // ⏰ إذا تجاوزت المدة 5 دقائق — أوقف polling أيضًا
    if (elapsedMinutes > 5) {
      console.log(`⏰ Timeout reached for ${userId} (${elapsedMinutes.toFixed(1)} min).`);
      db.run(
        "UPDATE liveness_data SET status = 'timeout' WHERE user_id = ?",
        [userId]
      );
      return res.json({ stop: true, status: 'timeout' });
    }

    // ⏳ إذا ما زالت العملية جارية
    console.log(`⏳ Still pending for ${userId} (${elapsedMinutes.toFixed(1)} min).`);
    return res.json([{ user_id: row.user_id, status: row.status }]);
  });
});

// 2. تخزين أو تحديث بيانات IP المزيف + إرجاع رابط مباشر للعميل (مع دعم actions)
app.post('/get_ip.php', (req, res) => {
  const data = req.body;
  console.log('📤 POST /get_ip.php', data);

  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ error: 'Invalid data format' });
  }

  const item = data[0];
  const { spoof_ip, user_id, transaction_id, liveness_id, actions } = item || {};

  if (!user_id || !transaction_id || !spoof_ip) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // استخدام الإجراءات المرسلة أو الإجراءات الافتراضية (مع حركات الرأس)
  let finalActions = actions;
  if (!finalActions || !Array.isArray(finalActions) || finalActions.length === 0) {
    // الإجراءات الافتراضية التي تطلب حركات الرأس
    finalActions = ["video_selfie_scan", "video_selfie_smile"];
  }
  const actionsJson = JSON.stringify(finalActions);
  console.log(`🎭 Actions for ${user_id}:`, finalActions);

  db.get("SELECT id FROM liveness_data WHERE user_id = ?", [user_id], (err, row) => {
    if (err) {
      console.error('❌ Database error:', err);
      return res.status(500).json({ error: err.message });
    }

    // الرابط يبقى كما هو دون تغيير
    const selfieLink = `https://algeria.blsspainglobal.com/assets/images/logo.png?user_id=${encodeURIComponent(user_id)}`;

    if (row) {
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
    } else {
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
  });
});

// 3. Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    server: 'liveness-bls.onrender.com',
    version: '2.3',
    timestamp: new Date().toISOString(),
    endpoints: {
      retrieve_data: 'GET /retrieve_data.php?user_id=USER_ID',
      store_spoof_ip: 'POST /get_ip.php',
      get_actions: 'GET /get_actions.php?user_id=USER_ID',
      update_liveness: 'POST /update_liveness.php',
      update_liveness_id: 'POST /update_liveness_id'
    }
  });
});

// 3.5 جلب الإجراءات المطلوبة للمستخدم (للاستخدام في الإضافة)
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

    let actions = ["video_selfie_blank"]; // القيمة الافتراضية
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
        // محاولة تحويل actions إلى مصفوفة إذا كانت نصية
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
    // محاولة تحويل actions إلى مصفوفة لكل صف
    const formattedRows = rows.map(row => {
      let actions = row.actions;
      try { actions = JSON.parse(actions); } catch(e) { /* keep as is */ }
      return { ...row, actions };
    });
    res.json(formattedRows);
  });
});

// 7. 🆕 نقطة نهاية مباشرة لتحديث liveness_id (للاستقبال من الإضافة)
app.post('/update_liveness_id', (req, res) => {
  const { user_id, liveness_id, transaction_id, spoof_ip } = req.body;
  console.log('📥 [UPDATE] POST /update_liveness_id', { user_id, liveness_id, transaction_id, spoof_ip });

  if (!user_id || !liveness_id) {
    return res.status(400).json({ 
      success: false, 
      error: 'user_id and liveness_id are required' 
    });
  }

  // تحديث السجل الموجود أو إدراجه إذا لم يكن موجودًا
  const updateSql = `
    INSERT INTO liveness_data (user_id, transaction_id, liveness_id, spoof_ip, status, created_at)
    VALUES (?, ?, ?, ?, 'completed', datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      liveness_id = excluded.liveness_id,
      transaction_id = COALESCE(excluded.transaction_id, transaction_id),
      spoof_ip = COALESCE(excluded.spoof_ip, spoof_ip),
      status = 'completed',
      created_at = datetime('now')
  `;

  db.run(updateSql, [user_id, transaction_id || 'tx-auto', liveness_id, spoof_ip || '0.0.0.0'], function(err) {
    if (err) {
      console.error('❌ Failed to update liveness_id:', err);
      return res.status(500).json({ success: false, error: err.message });
    }
    
    console.log(`✅ Liveness ID ${liveness_id} stored for user ${user_id}`);
    
    res.json({ 
      success: true, 
      message: 'Liveness ID updated successfully',
      user_id: user_id,
      liveness_id: liveness_id,
      status: 'completed'
    });
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
