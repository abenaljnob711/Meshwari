const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000; 

app.use(express.json());
app.use(cors());

// 1. الاتصال بقاعدة بيانات Supabase (PostgreSQL)
// استبدل الرابط أدناه برابط الاتصال المباشر الذي نسخته وضع كلمة المرور الخاصة بك
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgresql://postgres:[ Yemen*Sa#8962!xZi]@db.fwsizwqzmgrxqdjgtyvm.supabase.co:5432/postgres@db.fwsizwqzmgrxqdjgtyvm.supabase.co:5432/postgres';

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false // ضروري للاتصال المشفر بـ Supabase
  }
});

// اختبار الاتصال وتجهيز الجداول تلقائياً
async function initTables() {
    try {
        // جدول الزبائن (الركاب)
        await pool.query(`CREATE TABLE IF NOT EXISTS passengers (
            national_id TEXT PRIMARY KEY,
            full_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            device_id TEXT NOT NULL,
            customer_debt REAL DEFAULT 0.0,
            pending_creditor_driver_id INTEGER,
            is_blocked INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // جدول السائقين والسيارات
        await pool.query(`CREATE TABLE IF NOT EXISTS drivers (
            id SERIAL PRIMARY KEY,
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
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // جدول المحافظات وتفعيلها من الإدارة
        await pool.query(`CREATE TABLE IF NOT EXISTS governorates (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            is_enabled INTEGER DEFAULT 1
        )`);

        // سجل العمليات المالية والديون الآلي
        await pool.query(`CREATE TABLE IF NOT EXISTS transactions_log (
            id SERIAL PRIMARY KEY,
            operation_type TEXT,
            passenger_id TEXT,
            old_driver_id INTEGER,
            new_driver_id INTEGER,
            amount REAL,
            note TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // إدراج محافظات أولية تجريبية في اليمن
        await pool.query(`INSERT INTO governorates (name, is_enabled) VALUES 
            ('حضرموت - المكلا', 1),
            ('حضرموت - سيئون', 1),
            ('عدن', 1),
            ('صنعاء', 0),
            ('شبوة', 0)
            ON CONFLICT (name) DO NOTHING`);

        console.log('✅ تم الاتصال بقاعدة بيانات Supabase وتجهيز الجداول بنجاح.');
    } catch (err) {
        console.error('❌ خطأ في تهيئة قاعدة البيانات:', err.message);
    }
}

initTables();

// ==========================================
// مسارات الـ API (Endpoints)
// ==========================================

// أ. تسجيل أو دخول الزبون
app.post('/api/passenger/login', async (req, res) => {
    const { national_id, full_name, phone, device_id } = req.body;
    if (!national_id || !full_name || !phone || !device_id) {
        return res.status(400).json({ error: 'الرجاء إدخال كافة البيانات (رقم البطاقة، الاسم، الجوال، بصمة الجهاز)' });
    }

    try {
        const checkResult = await pool.query(`SELECT * FROM passengers WHERE national_id = $1`, [national_id]);
        
        if (checkResult.rows.length > 0) {
            res.json({ message: 'تم تسجيل الدخول بنجاح', passenger: checkResult.rows[0] });
        } else {
            const insertQuery = `INSERT INTO passengers (national_id, full_name, phone, device_id, customer_debt, is_blocked) VALUES ($1, $2, $3, $4, 0, 0) RETURNING *`;
            const newPass = await pool.query(insertQuery, [national_id, full_name, phone, device_id]);
            res.status(201).json({ message: 'تم التسجيل بنجاح دون تصوير احتراماً للخصوصية', passenger: newPass.rows[0] });
        }
    } catch (err) {
        res.status(500).json({ error: 'خطأ في قاعدة البيانات', details: err.message });
    }
});

// ب. إلغاء الرحلة وفرض غرامة الدين الكاش (1000 ريال)
app.post('/api/trip/cancel', async (req, res) => {
    const { national_id, driver_id } = req.body;
    if (!national_id) return res.status(400).json({ error: 'رقم بطاقة الراكب مطلوب' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE passengers SET customer_debt = 1000, is_blocked = 1, pending_creditor_driver_id = $1 WHERE national_id = $2`, 
            [driver_id || null, national_id]
        );
        await client.query('COMMIT');
        res.json({ message: 'تم إلغاء الرحلة وتطبيق غرامة الدين (1000 ريال) وحظر الحساب آلياً' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'فشل تطبيق الغرامة', details: err.message });
    } finally {
        client.release();
    }
});

// ج. تأكيد استلام الكاش من السائق الجديد
app.post('/api/trip/confirm-cash', async (req, res) => {
    const { national_id, new_driver_id, trip_fare } = req.body;

    const client = await pool.connect();
    try {
        const passResult = await client.query(`SELECT * FROM passengers WHERE national_id = $1`, [national_id]);
        if (passResult.rows.length === 0) {
            client.release();
            return res.status(404).json({ error: 'الزبون غير موجود' });
        }

        const passenger = passResult.rows[0];
        const debtAmount = passenger.customer_debt || 0;
        const oldDriverId = passenger.pending_creditor_driver_id;
        const totalCashCollected = trip_fare + debtAmount;

        await client.query('BEGIN');

        // 1. تصفية دين الراكب وفك الحظر
        await client.query(`UPDATE passengers SET customer_debt = 0, is_blocked = 0, pending_creditor_driver_id = NULL WHERE national_id = $1`, [national_id]);

        // 2. إضافة أجرة المشوار للسائق الجديد
        await client.query(`UPDATE drivers SET withdrawable_balance = withdrawable_balance + $1 WHERE id = $2`, [trip_fare, new_driver_id]);

        // 3. إضافة الدين للسائق القديم إن وجد
        if (debtAmount > 0 && oldDriverId) {
            await client.query(`UPDATE drivers SET withdrawable_balance = withdrawable_balance + $1 WHERE id = $2`, [debtAmount, oldDriverId]);
        }

        // 4. تسجيل العملية في السجل
        await client.query(
            `INSERT INTO transactions_log (operation_type, passenger_id, old_driver_id, new_driver_id, amount, note) VALUES ($1, $2, $3, $4, $5, $6)`,
            ['تسديد دين واستلام كاش', national_id, oldDriverId, new_driver_id, debtAmount, `إجمالي الكاش المستلم: ${totalCashCollected}`]
        );

        await client.query('COMMIT');
        res.json({ 
            message: 'تم تأكيد استلام الكاش وتوزيع الأموال آلياً بنجاح عبر سحابية Supabase', 
            total_cash_collected: totalCashCollected,
            debt_recovered: debtAmount
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'فشل إتمام المعركة المالية', details: err.message });
    } finally {
        client.release();
    }
});

// د. تحديث حالة السائق
app.put('/api/driver/duty-status', async (req, res) => {
    const { driver_id, is_off_duty } = req.body;
    try {
        await pool.query(`UPDATE drivers SET is_off_duty = $1 WHERE id = $2`, [is_off_duty, driver_id]);
        res.json({ message: is_off_duty ? 'تم تفعيل زر خارج الخدمة (موقعك مخفف الآن)' : 'أنت متصل لاستقبال الرحلات' });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في التحديث', details: err.message });
    }
});

// هـ. جلب حالة المحافظات والتحكم بها من الإدارة
app.get('/api/admin/governorates', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM governorates`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'خطأ في الجلب', details: err.message });
    }
});

app.put('/api/admin/governorate/:id', async (req, res) => {
    const govId = req.params.id;
    const { is_enabled } = req.body;
    try {
        await pool.query(`UPDATE governorates SET is_enabled = $1 WHERE id = $2`, [is_enabled, govId]);
        res.json({ message: 'تم تحديث حالة المحافظة بنجاح' });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في التحديث', details: err.message });
    }
});

// و. جلب سجل العمليات المالية للإدارة
app.get('/api/admin/transactions', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM transactions_log ORDER BY id DESC`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'خطأ في جلب السجل', details: err.message });
    }
});

// صفحة البداية
app.get('/', (req, res) => {
    res.send('🚖 سيرفر تطبيق "مشواري" (نظام السحاب Supabase PostgreSQL) يعمل بكفاءة تامة ومشوارك بأمان.. ووجهتك علينا!');
});

// تشغيل الخادم
app.listen(PORT, () => {
    console.log(`🚖 خادم تطبيق مشواري يعمل على البورت: ${PORT}`);
});
