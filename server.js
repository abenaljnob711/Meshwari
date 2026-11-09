const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000; 

app.use(express.json());
app.use(cors());

// 1. إنشاء وفتح اتصال قاعدة البيانات المحلية (SQLite)
const db = new sqlite3.Database('./taxi_ibn_al_janoub.db', (err) => {
    if (err) {
        console.error('خطأ في الاتصال بقاعدة البيانات:', err.message);
    } else {
        console.log('تم الاتصال بقاعدة البيانات بنجاح.');
        initTables();
    }
});

// 2. بناء الجداول بناءً على القواعد الذهبية
function initTables() {
    db.serialize(() => {
        // جدول الزبائن (الركاب): رقم البطاقة كمفتاح أساسي، لا تصوير، ذمة فردية ودين 1000 ريال
        db.run(`CREATE TABLE IF NOT EXISTS passengers (
            national_id TEXT PRIMARY KEY,
            full_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            device_id TEXT NOT NULL,
            customer_debt REAL DEFAULT 0.0,
            pending_creditor_driver_id INTEGER,
            is_blocked INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // جدول السائقين والسيارات
        db.run(`CREATE TABLE IF NOT EXISTS drivers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            national_id TEXT UNIQUE NOT NULL,
            full_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            device_id TEXT NOT NULL,
            car_info TEXT,
            plate_number TEXT,
            wallet_balance REAL DEFAULT 0.0,
            withdrawable_balance REAL DEFAULT 0.0,
            is_off_duty INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // جدول المحافظات وتفعيلها من الإدارة
        db.run(`CREATE TABLE IF NOT EXISTS governorates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            is_enabled INTEGER DEFAULT 1
        )`);

        // سجل العمليات المالية والديون الآلي
        db.run(`CREATE TABLE IF NOT EXISTS transactions_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_type TEXT,
            passenger_id TEXT,
            old_driver_id INTEGER,
            new_driver_id INTEGER,
            amount REAL,
            note TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // إدراج محافظات أولية تجريبية في اليمن
        db.run(`INSERT OR IGNORE INTO governorates (name, is_enabled) VALUES 
            ('حضرموت - المكلا', 1),
            ('حضرموت - سيئون', 1),
            ('عدن', 1),
            ('صنعاء', 0),
            ('شبوة', 0)`);
    });
}

// ==========================================
// مسارات الـ API (Endpoints)
// ==========================================

// أ. تسجيل أو دخول الزبون (برقم البطاقة وبصمة الجهاز)
app.post('/api/passenger/login', (req, res) => {
    const { national_id, full_name, phone, device_id } = req.body;
    if (!national_id || !full_name || !phone || !device_id) {
        return res.status(400).json({ error: 'الرجاء إدخال كافة البيانات (رقم البطاقة، الاسم، الجوال، بصمة الجهاز)' });
    }

    // التحقق من بصمة الجهاز لمنع التحايل
    db.get(`SELECT * FROM passengers WHERE national_id = ?`, [national_id], (err, passenger) => {
        if (err) return res.status(500).json({ error: 'خطأ في قاعدة البيانات' });

        if (passenger) {
            // موجود مسبقاً، تحديث بيانات الدخول والعودة به
            res.json({ message: 'تم تسجيل الدخول بنجاح', passenger });
        } else {
            // تسجيل جديد
            db.run(`INSERT INTO passengers (national_id, full_name, phone, device_id, customer_debt, is_blocked) VALUES (?, ?, ?, ?, 0, 0)`,
                [national_id, full_name, phone, device_id],
                function(err) {
                    if (err) return res.status(400).json({ error: 'رقم البطاقة مسجل مسبقاً' });
                    db.get(`SELECT * FROM passengers WHERE national_id = ?`, [national_id], (err, newPass) => {
                        res.status(201).json({ message: 'تم التسجيل بنجاح دون تصوير احتراماً للخصوصية', passenger: newPass });
                    });
                }
            );
        }
    });
});

// ب. إلغاء الرحلة وفرض غرامة الدين الكاش (1000 ريال)
app.post('/api/trip/cancel', (req, res) => {
    const { national_id, driver_id } = req.body;
    if (!national_id) return res.status(400).json({ error: 'رقم بطاقة الراكب مطلوب' });

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        // تسجيل دين الغرامة 1000 على الزبون وحظره، وتثبيت السائق المستحق للدين (old_driver_id)
        db.run(`UPDATE passengers SET customer_debt = 1000, is_blocked = 1, pending_creditor_driver_id = ? WHERE national_id = ?`, 
            [driver_id || null, national_id], 
            (err) => {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: 'فشل تطبيق الغرامة' });
                }
                db.run('COMMIT', () => {
                    res.json({ message: 'تم إلغاء الرحلة وتطبيق غرامة الدين (1000 ريال) وحظر الحساب آلياً' });
                });
            }
        );
    });
});

// ج. تأكيد استلام الكاش من السائق الجديد (تصفية الدين + إعطاء حق السائق القديم)
app.post('/api/trip/confirm-cash', (req, res) => {
    const { national_id, new_driver_id, trip_fare } = req.body; // trip_fare مثلاً 2000

    db.get(`SELECT * FROM passengers WHERE national_id = ?`, [national_id], (err, passenger) => {
        if (err || !passenger) return res.status(404).json({ error: 'الزبون غير موجود' });

        const debtAmount = passenger.customer_debt || 0;
        const oldDriverId = passenger.pending_creditor_driver_id;
        const totalCashCollected = trip_fare + debtAmount; // مثلاً 2000 + 1000 = 3000

        db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            // 1. تصفية دين الراكب وفك الحظر
            db.run(`UPDATE passengers SET customer_debt = 0, is_blocked = 0, pending_creditor_driver_id = NULL WHERE national_id = ?`, [national_id]);

            // 2. إضافة أجرة المشوار للسائق الجديد
            db.run(`UPDATE drivers SET withdrawable_balance = withdrawable_balance + ? WHERE id = ?`, [trip_fare, new_driver_id]);

            // 3. إذا كان هناك دين سابق، يضاف للسائق القديم آلياً
            if (debtAmount > 0 && oldDriverId) {
                db.run(`UPDATE drivers SET withdrawable_balance = withdrawable_balance + ? WHERE id = ?`, [debtAmount, oldDriverId]);
            }

            // 4. تسجيل العملية في سجل الحركات
            db.run(`INSERT INTO transactions_log (operation_type, passenger_id, old_driver_id, new_driver_id, amount, note) VALUES (?, ?, ?, ?, ?, ?)`,
                ['تسديد دين واستلام كاش', national_id, oldDriverId, new_driver_id, debtAmount, `إجمالي الكاش المستلم: ${totalCashCollected}`]
            );

            db.run('COMMIT', (err) => {
                if (err) return res.status(500).json({ error: 'فشل إتمام المعركة المالية' });
                res.json({ 
                    message: 'تم تأكيد استلام الكاش وتوزيع الأموال آلياً بنجاح', 
                    total_cash_collected: totalCashCollected,
                    debt_recovered: debtAmount
                });
            });
        });
    });
});

// د. تحديث حالة السائق (خارج الخدمة مؤقتاً / متصل)
app.put('/api/driver/duty-status', (req, res) => {
    const { driver_id, is_off_duty } = req.body; // 1 أو 0
    db.run(`UPDATE drivers SET is_off_duty = ? WHERE id = ?`, [is_off_duty, driver_id], (err) => {
        if (err) return res.status(500).json({ error: 'خطأ في التحديث' });
        res.json({ message: is_off_duty ? 'تم تفعيل زر خارج الخدمة (موقعك مخفف الآن)' : 'أنت متصل لاستقبال الرحلات' });
    });
});

// هـ. جلب حالة المحافظات والتحكم بها من الإدارة
app.get('/api/admin/governorates', (req, res) => {
    db.all(`SELECT * FROM governorates`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'خطأ في الجلب' });
        res.json(rows);
    });
});

app.put('/api/admin/governorate/:id', (req, res) => {
    const govId = req.params.id;
    const { is_enabled } = req.body;
    db.run(`UPDATE governorates SET is_enabled = ? WHERE id = ?`, [is_enabled, govId], (err) => {
        if (err) return res.status(500).json({ error: 'خطأ في التحديث' });
        res.json({ message: 'تم تحديث حالة المحافظة بنجاح' });
    });
});

// و. جلب سجل العمليات المالية transactions_log للإدارة
app.get('/api/admin/transactions', (req, res) => {
    db.all(`SELECT * FROM transactions_log ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'خطأ في جلب السجل' });
        res.json(rows);
    });
});

// صفحة البداية للتأكد من عمل السيرفر
app.get('/', (req, res) => {
    res.send('🚕 سيرفر تاكسي ابن الجنوب (نظام الكاش والديون الآلي) يعمل بكفاءة تامة!');
});

// تشغيل الخادم
app.listen(PORT, () => {
    console.log(`🚕 الخادم يعمل على البورت: ${PORT}`);
});
