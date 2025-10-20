// server.js — كامل ومحدث مع آلية إيقاف الـ Polling التلقائية
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

// إعداد CORS
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

// معالجة preflight لجميع المسارات
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', allowedHeaders.join(', '));
  return res.sendStatus(200);
});

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

// 1. استرجاع البيانات بواسطة user_id - مع آلية إيقاف الـ Polling
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
    
    // 🔥 التحقق إذا كان السجل مكتملاً لإيقاف الـ Polling
    if (rows.length > 0) {
      const record = rows[0];
      
      // إذا كان السجل يحتوي على liveness_id و spoof_ip و transaction_id
      if (record.liveness_id && record.spoof_ip && record.transaction_id) {
        console.log('🛑 Record completed - sending stop signal for user:', userId);
        
        // إرجاع إشارة لإيقاف الـ Polling
        return res.json({
          completed: true,
          stop_polling: true,
          message: 'Process completed - stop polling',
          data: rows
        });
      }
      
      // إذا كان الحالة "completed" أو "verified"
      if (record.status === 'completed' || record.status === 'verified') {
        console.log('🛑 Status completed - sending stop signal for user:', userId);
        
        return res.json({
          completed: true,
          stop_polling: true,
          message: 'Status completed - stop polling',
          data: rows
        });
      }
    }
    
    // إذا لم يكتمل بعد، إرجاع البيانات العادية
    res.json(rows);
  });
});

// 2. تخزين بيانات IP المزيف - مع دعم إيقاف الـ Polling
app.post('/get_ip.php', (req, res) => {
  const data = req.body;
  console.log('📤 POST /get_ip.php', data);

  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({ error: 'Invalid data format' });
  }

  const item = data[0];
  const { spoof_ip, user_id, transaction_id, liveness_id, status, final_update } = item || {};

  if (!user_id || !transaction_id || !spoof_ip) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // 🔥 بناء الاستعلام الديناميكي بناءً على البيانات المرسلة
  let query, params;
  
  if (final_update) {
    // إذا كانت هذه هي التحديثات النهائية
    console.log('🔥 Final update received for user:', user_id);
    query = `INSERT OR REPLACE INTO liveness_data 
             (user_id, transaction_id, liveness_id, spoof_ip, status, created_at)
             VALUES (?, ?, ?, ?, 'completed', datetime('now'))`;
    params = [user_id, transaction_id, liveness_id, spoof_ip];
  } else if (status) {
    // إذا تم إرسال حالة محددة
    query = `INSERT OR REPLACE INTO liveness_data 
             (user_id, transaction_id, liveness_id, spoof_ip, status, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`;
    params = [user_id, transaction_id, liveness_id, spoof_ip, status];
  } else {
    // التحديث العادي
    query = `INSERT OR REPLACE INTO liveness_data 
             (user_id, transaction_id, liveness_id, spoof_ip, status, created_at)
             VALUES (?, ?, ?, ?, COALESCE((SELECT status FROM liveness_data WHERE user_id = ?), 'pending'), datetime('now'))`;
    params = [user_id, transaction_id, liveness_id, spoof_ip, user_id];
  }

  db.run(query, params, function(err) {
    if (err) {
      console.error('❌ Database error:', err);
      return res.status(500).json({ error: err.message });
    }
    
    console.log('✅ Data stored - ID:', this.lastID, 'user_id=', user_id, 'status=', status || 'pending');
    
    res.json({
      success: true,
      message: final_update ? 'Final update stored successfully' : 'Data stored successfully',
      id: this.lastID,
      stop_polling: final_update || false // 🔥 إرجاع إشارة لإيقاف الـ Polling إذا كان final_update
    });
  });
});

// 3. Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    server: 'liveness-bls.uk',
    version: '2.1',
    timestamp: new Date().toISOString(),
    endpoints: {
      retrieve_data: 'GET /retrieve_data.php?user_id=USER_ID',
      store_spoof_ip: 'POST /get_ip.php',
      check_completion: 'GET /check_completion.php?user_id=USER_ID',
      update_liveness: 'POST /update_liveness.php'
    }
  });
});

// 4. تحديث نتائج التحقق - مع دعم إيقاف الـ Polling
app.post('/update_liveness.php', (req, res) => {
  const { user_id, liveness_id, spoof_ip, transaction_id, final_update } = req.body;
  console.log('📥 POST /update_liveness.php', req.body);

  if (!user_id || !liveness_id || !transaction_id) {
    return res.status(400).json({
      success: false,
      message: 'بيانات ناقصة: user_id, liveness_id, transaction_id مطلوبة'
    });
  }

  const status = final_update ? 'completed' : 'pending';
  
  db.run(
    `UPDATE liveness_data
     SET liveness_id = ?, status = ?, spoof_ip = COALESCE(?, spoof_ip)
     WHERE user_id = ? AND transaction_id = ?`,
    [liveness_id, status, spoof_ip, user_id, transaction_id],
    function(err) {
      if (err) {
        console.error('❌ Database error:', err);
        return res.status(500).json({ success: false, message: 'خطأ في قاعدة البيانات: ' + err.message });
      }

      if (this.changes === 0) {
        // إن لم يوجد سجل — أنشئه
        db.run(
          `INSERT INTO liveness_data 
           (user_id, transaction_id, liveness_id, spoof_ip, status, created_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`,
          [user_id, transaction_id, liveness_id, spoof_ip, status],
          function(insertErr) {
            if (insertErr) {
              console.error('❌ Insert error:', insertErr);
              return res.status(500).json({ success: false, message: 'خطأ في إنشاء السجل: ' + insertErr.message });
            }
            console.log('✅ New record created - ID:', this.lastID, 'final_update:', final_update);
            res.json({ 
              success: true, 
              message: 'تم حفظ نتائج التحقق بنجاح', 
              id: this.lastID, 
              status: status,
              stop_polling: final_update || false
            });
          }
        );
      } else {
        console.log('✅ Liveness results updated - changes:', this.changes, 'final_update:', final_update);
        res.json({ 
          success: true, 
          message: 'تم تحديث نتائج التحقق بنجاح', 
          changes: this.changes, 
          status: status,
          stop_polling: final_update || false
        });
      }
    }
  );
});

// 5. الحصول على حالة المستخدم
app.get('/user_status.php', (req, res) => {
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id parameter is required' });

  db.get(
    "SELECT user_id, transaction_id, spoof_ip, status, created_at FROM liveness_data WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
    [userId],
    (err, row) => {
      if (err) {
        console.error('❌ Database error:', err);
        return res.status(500).json({ error: err.message });
      }
      if (row) res.json({ success: true, data: row });
      else res.json({ success: false, message: 'لم يتم العثور على بيانات للمستخدم' });
    }
  );
});

// 6. frontend_snippet (عرض مثال التبديل)
app.get('/frontend_snippet', (req, res) => {
  res.type('text/plain').send(`// مثال لإرسال البيانات مع إشارة الإكمال النهائي
const res = await fetch("https://liveness-bls.onrender.com/get_ip.php", {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify([{
    user_id: "\${userData.user_id}",
    liveness_id: result.event_session_id,
    spoof_ip: "\${userData.spoof_ip}",
    transaction_id: "\${userData.transaction_id}",
    final_update: true // 🔥 إشارة الإكمال النهائي
  }])
});`);
});

// 7. 🔥 endpoint جديد للتحقق من اكتمال العملية
app.get('/check_completion.php', (req, res) => {
  const userId = req.query.user_id;
  console.log('🔍 GET /check_completion.php?user_id=', userId);

  if (!userId) {
    return res.status(400).json({ error: 'user_id parameter is required' });
  }

  db.get(
    "SELECT user_id, transaction_id, liveness_id, spoof_ip, status FROM liveness_data WHERE user_id = ?",
    [userId],
    (err, row) => {
      if (err) {
        console.error('❌ Database error:', err);
        return res.status(500).json({ error: err.message });
      }
      
      if (!row) {
        return res.json({ 
          completed: false,
          stop_polling: false,
          message: 'No data found for user'
        });
      }
      
      // التحقق من اكتمال البيانات
      const isCompleted = row.liveness_id && row.spoof_ip && row.transaction_id;
      const statusCompleted = row.status === 'completed' || row.status === 'verified';
      
      const result = {
        completed: isCompleted || statusCompleted,
        stop_polling: isCompleted || statusCompleted,
        user_id: row.user_id,
        status: row.status,
        has_liveness_id: !!row.liveness_id,
        has_spoof_ip: !!row.spoof_ip,
        has_transaction_id: !!row.transaction_id,
        message: isCompleted || statusCompleted ? 
          'Process completed - stop polling' : 
          'Process still in progress'
      };
      
      console.log('✅ Completion check for', userId, '- Stop polling:', result.stop_polling);
      res.json(result);
    }
  );
});

// 8. Temporary debug endpoint
app.get('/debug_all', (req, res) => {
  db.all("SELECT * FROM liveness_data ORDER BY created_at DESC LIMIT 500", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 9. 🔥 endpoint لمسح بيانات مستخدم محدد (للتجارب)
app.delete('/clear_user/:user_id', (req, res) => {
  const userId = req.params.user_id;
  
  db.run("DELETE FROM liveness_data WHERE user_id = ?", [userId], function(err) {
    if (err) {
      console.error('❌ Error deleting user data:', err);
      return res.status(500).json({ error: err.message });
    }
    
    console.log('✅ User data cleared for:', userId, 'changes:', this.changes);
    res.json({ 
      success: true, 
      message: 'User data cleared successfully',
      changes: this.changes 
    });
  });
});

// 10. 🔥 endpoint للحصول على إحصائيات
app.get('/stats', (req, res) => {
  db.all(`
    SELECT 
      COUNT(*) as total_records,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
      COUNT(CASE WHEN liveness_id IS NOT NULL THEN 1 END) as has_liveness_id
    FROM liveness_data
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const stats = rows[0];
    res.json({
      success: true,
      stats: stats,
      server_time: new Date().toISOString()
    });
  });
});

// تنظيف البيانات القديمة (كل ساعة)
setInterval(() => {
  db.run("DELETE FROM liveness_data WHERE created_at < datetime('now', '-2 hours')", (err) => {
    if (err) console.error('❌ Error cleaning old data:', err);
    else console.log('✅ Old data cleaned');
  });
}, 3600000);

// معالجة الأخطاء غير المتوقعة
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// بدء الخادم
app.listen(PORT, () => {
  console.log(`🚀 Liveness BLS Server running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
  console.log(`📍 API Docs: http://localhost:${PORT}/`);
  console.log('🔥 New features: Auto-stop polling mechanism activated');
});

module.exports = app;
