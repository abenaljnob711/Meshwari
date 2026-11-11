'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const required = ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must contain at least 32 characters.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));

const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || origins.length === 0 || origins.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const validNationalId = v => /^[0-9]{6,20}$/.test(String(v || ''));
const signToken = (sub, role) => jwt.sign({ sub: String(sub), role }, process.env.JWT_SECRET, { expiresIn: role === 'admin' ? '4h' : '12h' });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
  try { req.user = jwt.verify(h.slice(7), process.env.JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'الجلسة غير صالحة، سجل الدخول مجدداً' }); }
}
const role = (...allowed) => (req, res, next) => {
  if (!req.user || !allowed.includes(req.user.role)) return res.status(403).json({ error: 'ليس لديك صلاحية' });
  next();
};

async function audit(actorId, action, targetId, details = {}) {
  await pool.query(
    `INSERT INTO mesh_audit_logs(actor_id, action, target_id, details)
     VALUES ($1,$2,$3,$4)`,
    [actorId && /^\d+$/.test(String(actorId)) ? actorId : null, action, targetId || null, JSON.stringify(details)]
  );
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mesh_accounts (
      id BIGSERIAL PRIMARY KEY,
      national_id VARCHAR(30) UNIQUE NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      phone VARCHAR(40) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('passenger','driver')),
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','active','rejected','blocked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mesh_passenger_profiles (
      account_id BIGINT PRIMARY KEY REFERENCES mesh_accounts(id) ON DELETE CASCADE,
      customer_debt NUMERIC(12,2) NOT NULL DEFAULT 0,
      is_blocked BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS mesh_driver_profiles (
      account_id BIGINT PRIMARY KEY REFERENCES mesh_accounts(id) ON DELETE CASCADE,
      car_type VARCHAR(100) NOT NULL,
      car_model VARCHAR(100) NOT NULL,
      car_color VARCHAR(60) NOT NULL,
      plate_number VARCHAR(50) NOT NULL,
      registration_number VARCHAR(80) NOT NULL,
      vehicle_image_url TEXT,
      wallet_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      withdrawable_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      is_off_duty BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS mesh_otp_requests (
      id BIGSERIAL PRIMARY KEY,
      account_id BIGINT NOT NULL REFERENCES mesh_accounts(id) ON DELETE CASCADE,
      otp_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS mesh_otp_account_idx ON mesh_otp_requests(account_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS mesh_trips (
      id BIGSERIAL PRIMARY KEY,
      passenger_id BIGINT NOT NULL REFERENCES mesh_accounts(id),
      driver_id BIGINT REFERENCES mesh_accounts(id),
      pickup_address TEXT,
      dropoff_address TEXT NOT NULL,
      pickup_lat DOUBLE PRECISION,
      pickup_lng DOUBLE PRECISION,
      dropoff_lat DOUBLE PRECISION,
      dropoff_lng DOUBLE PRECISION,
      distance_km NUMERIC(10,2),
      fare_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'requested',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mesh_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mesh_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      actor_id BIGINT,
      action VARCHAR(100) NOT NULL,
      target_id BIGINT,
      details JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO mesh_settings(setting_key,setting_value)
    VALUES ('base_fare','1000'),('per_km_rate','300')
    ON CONFLICT (setting_key) DO NOTHING;
  `);
}

app.get('/api/health', asyncHandler(async (req,res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, service: 'Meshwari API', database: 'connected' });
}));

// Register: a national ID is permanently assigned to one role.
app.post('/api/register', asyncHandler(async (req,res) => {
  const { role: requestedRole } = req.body || {};
  const nationalId = clean(req.body.nationalId,30);
  const fullName = clean(req.body.fullName,150);
  const phone = clean(req.body.phone,40);
  if (!['passenger','driver'].includes(requestedRole) || !validNationalId(nationalId) || !fullName || !phone) {
    return res.status(400).json({ error: 'تحقق من نوع الحساب والاسم ورقم البطاقة والجوال' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = await client.query('SELECT id,role,status FROM mesh_accounts WHERE national_id=$1 FOR UPDATE',[nationalId]);
    if (old.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: old.rows[0].role === requestedRole ? 'الحساب مسجل مسبقاً' : 'رقم البطاقة مرتبط بنوع حساب آخر ولا يمكن تغيير دوره' });
    }
    const inserted = await client.query(
      `INSERT INTO mesh_accounts(national_id,full_name,phone,role,status)
       VALUES($1,$2,$3,$4,'pending') RETURNING id`,
      [nationalId,fullName,phone,requestedRole]
    );
    const id = inserted.rows[0].id;
    if (requestedRole === 'passenger') {
      await client.query('INSERT INTO mesh_passenger_profiles(account_id) VALUES($1)',[id]);
    } else {
      const car = req.body.car || {};
      const values = ['type','model','color','plateNumber','registrationNumber'].map(k => clean(car[k],120));
      if (values.some(v => !v)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'أكمل بيانات السيارة والملكية واللوحة' });
      }
      await client.query(
        `INSERT INTO mesh_driver_profiles(account_id,car_type,car_model,car_color,plate_number,registration_number)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [id,...values]
      );
    }
    await client.query('COMMIT');
    await audit(null, `${requestedRole}_registration`, id);
    res.status(201).json({ ok:true, status:'pending', message:'تم استلام طلبك وهو قيد مراجعة الإدارة' });
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}));

// Public request notification only. The admin issues the actual one-time code.
app.post('/api/auth/request-code', asyncHandler(async (req,res) => {
  const nationalId = clean(req.body.nationalId,30);
  if (!validNationalId(nationalId)) return res.status(400).json({error:'رقم البطاقة غير صحيح'});
  const r = await pool.query('SELECT id,role,status FROM mesh_accounts WHERE national_id=$1',[nationalId]);
  if (!r.rowCount) return res.status(404).json({error:'الحساب غير موجود'});
  if (['blocked','rejected'].includes(r.rows[0].status)) return res.status(403).json({error:'الحساب موقوف أو مرفوض'});
  if (r.rows[0].role === 'driver' && r.rows[0].status !== 'active') return res.status(403).json({error:'السائق بانتظار اعتماد الإدارة'});
  res.json({ok:true,message:'تم تسجيل طلبك. اطلب رمز الدخول من الإدارة'});
}));

app.post('/api/auth/verify-code', asyncHandler(async (req,res) => {
  const nationalId = clean(req.body.nationalId,30);
  const code = clean(req.body.code,6);
  if (!validNationalId(nationalId) || !/^\d{6}$/.test(code)) return res.status(400).json({error:'بيانات التحقق غير صحيحة'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = await client.query('SELECT * FROM mesh_accounts WHERE national_id=$1 FOR UPDATE',[nationalId]);
    if (!a.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({error:'الحساب غير موجود'}); }
    const account = a.rows[0];
    if (['blocked','rejected'].includes(account.status)) { await client.query('ROLLBACK'); return res.status(403).json({error:'الحساب غير مسموح له بالدخول'}); }
    const o = await client.query(
      `SELECT * FROM mesh_otp_requests WHERE account_id=$1 AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[account.id]
    );
    if (!o.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({error:'لا يوجد رمز صالح'}); }
    const otp = o.rows[0];
    if (new Date(otp.expires_at) < new Date() || otp.attempts >= 5) {
      await client.query('ROLLBACK'); return res.status(400).json({error:'انتهت صلاحية الرمز'});
    }
    if (!await bcrypt.compare(code,otp.otp_hash)) {
      await client.query('UPDATE mesh_otp_requests SET attempts=attempts+1 WHERE id=$1',[otp.id]);
      await client.query('COMMIT');
      return res.status(400).json({error:'الرمز غير صحيح'});
    }
    if (account.status !== 'active' && account.role === 'passenger') {
      account.status = 'active';
      await client.query("UPDATE mesh_accounts SET status='active',updated_at=NOW() WHERE id=$1",[account.id]);
    }
    if (account.status !== 'active') {
      await client.query('ROLLBACK'); return res.status(403).json({error:'الحساب لم يعتمد بعد'});
    }
    await client.query('UPDATE mesh_otp_requests SET used_at=NOW() WHERE id=$1',[otp.id]);
    await client.query('COMMIT');
    await audit(account.id,'login',account.id);
    res.json({ok:true,token:signToken(account.id,account.role),account:{id:account.id,fullName:account.full_name,role:account.role,status:account.status}});
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

app.get('/api/me', auth, asyncHandler(async (req,res) => {
  if (!['passenger','driver'].includes(req.user.role)) return res.status(403).json({error:'غير مسموح'});
  const r = await pool.query(
    `SELECT a.id,a.national_id,a.full_name,a.phone,a.role,a.status,
      p.customer_debt,p.is_blocked,d.car_type,d.car_model,d.car_color,d.plate_number,
      d.registration_number,d.vehicle_image_url,d.wallet_balance,d.withdrawable_balance,d.is_off_duty
     FROM mesh_accounts a
     LEFT JOIN mesh_passenger_profiles p ON p.account_id=a.id
     LEFT JOIN mesh_driver_profiles d ON d.account_id=a.id WHERE a.id=$1`,
    [req.user.sub]
  );
  if (!r.rowCount || r.rows[0].role !== req.user.role || r.rows[0].status !== 'active') return res.status(403).json({error:'الحساب غير نشط أو الدور غير مطابق'});
  res.json({account:r.rows[0]});
}));

app.get('/api/settings', asyncHandler(async (req,res) => {
  const r = await pool.query('SELECT setting_key,setting_value FROM mesh_settings');
  res.json({settings:Object.fromEntries(r.rows.map(x=>[x.setting_key,Number(x.setting_value)]))});
}));

app.post('/api/trips', auth, role('passenger'), asyncHandler(async (req,res) => {
  const destination = clean(req.body.destination,500);
  if (!destination) return res.status(400).json({error:'أدخل الوجهة'});
  const account = await pool.query("SELECT status FROM mesh_accounts WHERE id=$1",[req.user.sub]);
  if (!account.rowCount || account.rows[0].status !== 'active') return res.status(403).json({error:'الحساب غير نشط'});
  const s = await pool.query("SELECT setting_key,setting_value FROM mesh_settings WHERE setting_key IN ('base_fare','per_km_rate')");
  const cfg = Object.fromEntries(s.rows.map(x=>[x.setting_key,Number(x.setting_value)]));
  // مبدئياً تقدير توضيحي فقط؛ لا يصبح سعراً نهائياً قبل ربط مسار GPS.
  const distance = 5;
  const fare = (cfg.base_fare || 1000) + (cfg.per_km_rate || 300) * distance;
  const t = await pool.query(
    `INSERT INTO mesh_trips(passenger_id,dropoff_address,distance_km,fare_amount)
     VALUES($1,$2,$3,$4) RETURNING *`,[req.user.sub,destination,distance,fare]
  );
  res.status(201).json({ok:true,trip:t.rows[0],estimated:true});
}));

app.put('/api/driver/duty', auth, role('driver'), asyncHandler(async (req,res) => {
  if (typeof req.body.offDuty !== 'boolean') return res.status(400).json({error:'حالة الدوام غير صحيحة'});
  const a = await pool.query("SELECT status FROM mesh_accounts WHERE id=$1",[req.user.sub]);
  if (!a.rowCount || a.rows[0].status !== 'active') return res.status(403).json({error:'السائق غير معتمد'});
  await pool.query('UPDATE mesh_driver_profiles SET is_off_duty=$1 WHERE account_id=$2',[req.body.offDuty,req.user.sub]);
  res.json({ok:true,offDuty:req.body.offDuty});
}));

// Independent administration login and API.
app.post('/api/admin/login', rateLimit({windowMs:15*60*1000,limit:5,standardHeaders:true,legacyHeaders:false}), asyncHandler(async (req,res) => {
  const username = clean(req.body.username,100);
  const password = String(req.body.password || '');
  const valid = username === process.env.ADMIN_USERNAME && await bcrypt.compare(password,process.env.ADMIN_PASSWORD_HASH);
  if (!valid) return res.status(401).json({error:'بيانات الدخول غير صحيحة'});
  res.json({ok:true,token:signToken('admin','admin')});
}));
app.get('/api/admin/overview',auth,role('admin'),asyncHandler(async(req,res)=>{
  const r=await pool.query(`SELECT
    (SELECT COUNT(*) FROM mesh_accounts WHERE role='passenger') passengers,
    (SELECT COUNT(*) FROM mesh_accounts WHERE role='driver') drivers,
    (SELECT COUNT(*) FROM mesh_accounts WHERE role='driver' AND status='active') active_drivers,
    (SELECT COUNT(*) FROM mesh_accounts WHERE status='pending') pending_accounts,
    (SELECT COUNT(*) FROM mesh_trips) trips`);
  res.json({overview:r.rows[0]});
}));
app.get('/api/admin/accounts',auth,role('admin'),asyncHandler(async(req,res)=>{
  const r=await pool.query(`SELECT a.id,a.national_id,a.full_name,a.phone,a.role,a.status,a.created_at,
    d.car_type,d.car_model,d.car_color,d.plate_number,d.registration_number,d.wallet_balance
    FROM mesh_accounts a LEFT JOIN mesh_driver_profiles d ON d.account_id=a.id ORDER BY a.created_at DESC`);
  res.json({accounts:r.rows});
}));
app.post('/api/admin/accounts/:id/issue-code',auth,role('admin'),asyncHandler(async(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'معرف غير صحيح'});
  const a=await pool.query('SELECT id,role,status FROM mesh_accounts WHERE id=$1',[id]);
  if(!a.rowCount)return res.status(404).json({error:'الحساب غير موجود'});
  if(a.rows[0].role==='driver'&&a.rows[0].status!=='active')return res.status(403).json({error:'اعتمد السائق أولاً'});
  const code=String(crypto.randomInt(100000,1000000));
  const hash=await bcrypt.hash(code,12);
  await pool.query('INSERT INTO mesh_otp_requests(account_id,otp_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL \'5 minutes\')',[id,hash]);
  await audit('admin','issue_code',id);
  res.json({ok:true,code,expiresInSeconds:300});
}));
app.patch('/api/admin/drivers/:id/status',auth,role('admin'),asyncHandler(async(req,res)=>{
  const id=Number(req.params.id), status=clean(req.body.status,20);
  if(!Number.isSafeInteger(id)||!['active','rejected','blocked'].includes(status))return res.status(400).json({error:'بيانات غير صحيحة'});
  const r=await pool.query("UPDATE mesh_accounts SET status=$1,updated_at=NOW() WHERE id=$2 AND role='driver' RETURNING id,status",[status,id]);
  if(!r.rowCount)return res.status(404).json({error:'السائق غير موجود'});
  await audit('admin','driver_status',id,{status});
  res.json({ok:true,account:r.rows[0]});
}));
app.patch('/api/admin/passengers/:id/status',auth,role('admin'),asyncHandler(async(req,res)=>{
  const id=Number(req.params.id), status=clean(req.body.status,20);
  if(!Number.isSafeInteger(id)||!['active','blocked','rejected'].includes(status))return res.status(400).json({error:'بيانات غير صحيحة'});
  const r=await pool.query("UPDATE mesh_accounts SET status=$1,updated_at=NOW() WHERE id=$2 AND role='passenger' RETURNING id,status",[status,id]);
  if(!r.rowCount)return res.status(404).json({error:'الراكب غير موجود'});
  await audit('admin','passenger_status',id,{status});
  res.json({ok:true,account:r.rows[0]});
}));
app.get('/api/admin/trips',auth,role('admin'),asyncHandler(async(req,res)=>{
  const r=await pool.query(`SELECT t.*,p.full_name passenger_name,d.full_name driver_name
    FROM mesh_trips t JOIN mesh_accounts p ON p.id=t.passenger_id
    LEFT JOIN mesh_accounts d ON d.id=t.driver_id ORDER BY t.created_at DESC LIMIT 500`);
  res.json({trips:r.rows});
}));
app.get('/api/admin/audit',auth,role('admin'),asyncHandler(async(req,res)=>{
  const r=await pool.query('SELECT * FROM mesh_audit_logs ORDER BY created_at DESC LIMIT 500');
  res.json({logs:r.rows});
}));

app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{
  console.error('API error:',err.message);
  if(res.headersSent)return next(err);
  res.status(err.message==='Origin not allowed'?403:500).json({error:err.message==='Origin not allowed'?'المصدر غير مسموح':'حدث خطأ داخلي في الخادم'});
});

(async()=>{
  try {
    await initDb();
    app.listen(PORT,'0.0.0.0',()=>console.log(`Meshwari API listening on ${PORT}`));
  } catch(e) {
    console.error('Database startup failed:',e);
    process.exit(1);
  }
})();
