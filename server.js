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
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
<<<<<<< HEAD
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
=======
  origin: '*',
  methods: ['GET', 'POST'],
  credentials: true
>>>>>>> 17582729e38081aaf71bfb6fcea4c7f3738cc386
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

<<<<<<< HEAD
// قاعدة بيانات SQLite
const dbPath = path.join(__dirname, 'liveness.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err);
    } else {
        console.log('✅ Connected to SQLite database');
    }
});
=======
// استخدم قاعدة بيانات ملف بدلاً من الذاكرة
const db = new sqlite3.Database('./liveness.db');
>>>>>>> 17582729e38081aaf71bfb6fcea4c7f3738cc386

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
    )`, (err) => {
        if (err) {
            console.error('❌ Error creating table:', err);
        } else {
            console.log('✅ Table ready');
        }
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
        console.log('✅ Data retrieved:', rows.length, 'records');
        res.json(rows);
    });
});

// 2. تخزين بيانات IP المزيف
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

// 3. Health check endpoint
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

// صفحة رئيسية
app.get('/', (req, res) => {
    res.json({ 
        message: 'Liveness BLS Server is running',
        status: 'OK',
        timestamp: new Date().toISOString()
    });
});

// تنظيف البيانات القديمة (كل ساعة)
setInterval(() => {
    db.run("DELETE FROM liveness_data WHERE created_at < datetime('now', '-2 hours')", (err) => {
        if (err) {
            console.error('❌ Error cleaning old data:', err);
        } else {
            console.log('✅ Old data cleaned');
        }
    });
}, 3600000);

app.listen(PORT, () => {
<<<<<<< HEAD
    console.log(`🚀 Liveness BLS Server running on port ${PORT}`);
    console.log(`📍 Health: https://liveness-bls.onrender.com/health`);
    console.log(`📍 Retrieve: https://liveness-bls.onrender.com/retrieve_data.php?user_id=test123`);
});
=======
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
>>>>>>> 17582729e38081aaf71bfb6fcea4c7f3738cc386
