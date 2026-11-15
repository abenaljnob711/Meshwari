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
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);

const required = ['DATABASE_URL', 'JWT_SECRET'];
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

const origins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(x => x.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || origins.length === 0 || origins.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 60,
  standardHeaders: true, legacyHeaders: false
});
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'محاولات كثيرة. حاول بعد 15 دقيقة' }
});
const adminRecoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'محاولات كثيرة. حاول لاحقاً' }
});

app.use('/api', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));

const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const clean = (value, max = 200) => String(value ?? '').trim().slice(0, max);
const validNationalId = value => /^[0-9]{6,20}$/.test(String(value || ''));

const validAdminPassword = value =>
  typeof value === 'string' && value.length >= 12 && value.length <= 200;

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const signToken = (sub, accountRole, tokenVersion = 0) =>
  jwt.sign(
    accountRole === 'admin'
      ? { sub: String(sub), role: accountRole, ver: Number(tokenVersion) }
      : { sub: String(sub), role: accountRole },
    process.env.JWT_SECRET,
    { expiresIn: accountRole === 'admin' ? '4h' : '12h' }
  );

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (decoded.role === 'admin') {
      const admin = await pool.query(
        'SELECT token_version FROM mesh_admin_auth WHERE id = 1'
      );
      if (!admin.rowCount || Number(decoded.ver) !== Number(admin.rows[0].token_version)) {
        return res.status(401).json({ error: 'انتهت صلاحية الجلسة. سجل الدخول مجدداً' });
      }
    } else if (['passenger', 'driver'].includes(decoded.role)) {
      const account = await pool.query(
        `UPDATE mesh_accounts
         SET last_activity_at = NOW()
         WHERE id = $1 AND role = $2 AND status = 'active'
           AND lifecycle_state = 'open'
         RETURNING id`,
        [decoded.sub, decoded.role]
      );
      if (!account.rowCount) {
        return res.status(403).json({ error: 'الحساب موقوف أو مغلق أو غير معتمد' });
      }
    }
    req.user = decoded;
    return next();
  } catch (error) {
    if (error && error.name === 'JsonWebTokenError' || error && error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'الجلسة غير صالحة، سجل الدخول مجدداً' });
    }
    return next(error);
  }
}

const role = (...allowed) => (req, res, next) => {
  if (!req.user || !allowed.includes(req.user.role)) {
    return res.status(403).json({ error: 'ليس لديك صلاحية' });
  }
  next();
};

async function audit(actorId, action, targetId, details = {}) {
  await pool.query(
    `INSERT INTO mesh_audit_logs (actor_id, action, target_id, details)
     VALUES ($1, $2, $3, $4)`,
    [
      actorId && /^\d+$/.test(String(actorId)) ? actorId : null,
      action, targetId || null, JSON.stringify(details)
    ]
  );
}

const DEFAULT_APPROVAL_POLICIES = { passenger: 'manual', driver: 'manual' };

async function getApprovalPolicies(db = pool) {
  const result = await db.query(
    `SELECT setting_key, setting_value FROM mesh_settings
     WHERE setting_key IN ('passenger_approval_mode','driver_approval_mode')`
  );
  const values = Object.fromEntries(result.rows.map(row => [row.setting_key, row.setting_value]));
  return {
    passenger: values.passenger_approval_mode === 'automatic' ? 'automatic' : DEFAULT_APPROVAL_POLICIES.passenger,
    driver: values.driver_approval_mode === 'automatic' ? 'automatic' : DEFAULT_APPROVAL_POLICIES.driver
  };
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
    ALTER TABLE mesh_accounts ADD COLUMN IF NOT EXISTS approval_mode VARCHAR(20) NOT NULL DEFAULT 'manual';
    ALTER TABLE mesh_accounts ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30) NOT NULL DEFAULT 'not_submitted';
    ALTER TABLE mesh_accounts ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE mesh_accounts ADD COLUMN IF NOT EXISTS lifecycle_state VARCHAR(20) NOT NULL DEFAULT 'open';
    ALTER TABLE mesh_accounts ADD COLUMN IF NOT EXISTS status_before_block VARCHAR(20);
    ALTER TABLE mesh_accounts ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
    ALTER TABLE mesh_accounts ADD COLUMN IF NOT EXISTS closure_reason TEXT;
    ALTER TABLE mesh_accounts ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
    ALTER TABLE mesh_accounts ADD COLUMN IF NOT EXISTS anonymization_reason TEXT;
    ALTER TABLE mesh_accounts ALTER COLUMN national_id DROP NOT NULL;
    DO $$ BEGIN
      ALTER TABLE mesh_accounts ADD CONSTRAINT mesh_accounts_lifecycle_state_check
        CHECK (lifecycle_state IN ('open','suspended','closed','anonymized'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    -- Legacy blocked accounts were temporary stops in the previous administration UI.
    UPDATE mesh_accounts SET lifecycle_state = 'suspended',
      status_before_block = CASE
        WHEN verification_status IN ('awaiting_documents','pending') THEN 'pending'
        ELSE 'active' END
      WHERE status = 'blocked' AND lifecycle_state = 'open' AND status_before_block IS NULL;
    CREATE INDEX IF NOT EXISTS mesh_accounts_activity_idx
      ON mesh_accounts(last_activity_at DESC);
    CREATE INDEX IF NOT EXISTS mesh_accounts_lifecycle_idx
      ON mesh_accounts(lifecycle_state, role, status);

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
    -- Existing rows predate activity tracking; migrate their baseline exactly once.
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM mesh_settings WHERE setting_key = 'account_activity_tracking_migrated') THEN
        UPDATE mesh_accounts SET last_activity_at = created_at;
        INSERT INTO mesh_settings(setting_key, setting_value)
          VALUES ('account_activity_tracking_migrated', 'true') ON CONFLICT (setting_key) DO NOTHING;
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS mesh_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      actor_id BIGINT,
      action VARCHAR(100) NOT NULL,
      target_id BIGINT,
      details JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mesh_admin_auth (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      username VARCHAR(100) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      recovery_hash TEXT,
      token_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO mesh_settings(setting_key, setting_value)
    VALUES ('base_fare','1000'), ('per_km_rate','300'),
      ('passenger_approval_mode','manual'), ('driver_approval_mode','manual')
    ON CONFLICT (setting_key) DO NOTHING;
  `);

  // Migration: preserve the existing Render admin login once, then use database credentials.
  const existing = await pool.query('SELECT id FROM mesh_admin_auth WHERE id = 1');
  if (!existing.rowCount && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH) {
    await pool.query(
      `INSERT INTO mesh_admin_auth(id, username, password_hash)
       VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`,
      [clean(process.env.ADMIN_USERNAME, 100), process.env.ADMIN_PASSWORD_HASH]
    );
    console.log('Legacy admin credentials migrated into database.');
  }
}

/* Health */
app.get('/api/health', asyncHandler(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, service: 'Meshwari API', database: 'connected' });
}));

/* Registration */
app.post('/api/register', asyncHandler(async (req, res) => {
  const requestedRole = req.body?.role;
  const nationalId = clean(req.body?.nationalId, 30);
  const fullName = clean(req.body?.fullName, 150);
  const phone = clean(req.body?.phone, 40);

  if (!['passenger', 'driver'].includes(requestedRole) ||
      !validNationalId(nationalId) || !fullName || !phone) {
    return res.status(400).json({ error: 'تحقق من نوع الحساب والاسم ورقم البطاقة والجوال' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const policies = await getApprovalPolicies(client);
    const selectedMode = policies[requestedRole];
    const accountStatus = 'pending';
    const verificationStatus = 'awaiting_documents';

    const old = await client.query(
      `SELECT id, role, status FROM mesh_accounts WHERE national_id = $1 FOR UPDATE`,
      [nationalId]
    );
    if (old.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: old.rows[0].role === requestedRole
          ? 'الحساب مسجل مسبقاً'
          : 'رقم البطاقة مرتبط بنوع حساب آخر ولا يمكن تغيير دوره'
      });
    }

    let carValues = [];
    if (requestedRole === 'driver') {
      const car = req.body?.car || {};
      carValues = [
        clean(car.type, 120), clean(car.model, 120), clean(car.color, 120),
        clean(car.plateNumber, 120), clean(car.registrationNumber, 120)
      ];
      if (carValues.some(value => !value)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'أكمل بيانات السيارة والملكية واللوحة' });
      }
    }

    const inserted = await client.query(
      `INSERT INTO mesh_accounts
       (national_id, full_name, phone, role, status, approval_mode, verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [nationalId, fullName, phone, requestedRole, accountStatus, selectedMode, verificationStatus]
    );
    const id = inserted.rows[0].id;

    if (requestedRole === 'passenger') {
      await client.query('INSERT INTO mesh_passenger_profiles(account_id) VALUES ($1)', [id]);
    } else {
      await client.query(
        `INSERT INTO mesh_driver_profiles
         (account_id, car_type, car_model, car_color, plate_number, registration_number)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, ...carValues]
      );
    }
    await client.query('COMMIT');
    await audit(null, `${requestedRole}_registration`, id, { approvalMode: selectedMode, verificationStatus });

    return res.status(201).json({
      ok: true, status: accountStatus, approvalMode: selectedMode, verificationStatus,
      message: selectedMode === 'automatic'
        ? 'تم استلام طلبك. خيار الاعتماد التلقائي محدد، لكن يلزم استكمال التحقق الآلي من الوثائق قبل التفعيل.'
        : 'تم استلام طلبك وهو بانتظار مراجعة واعتماد الإدارة'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'الحساب مسجل مسبقاً' });
    throw error;
  } finally {
    client.release();
  }
}));

/* Login code request */
app.post('/api/auth/request-code', asyncHandler(async (req, res) => {
  const nationalId = clean(req.body?.nationalId, 30);
  if (!validNationalId(nationalId)) return res.status(400).json({ error: 'رقم البطاقة غير صحيح' });

  const result = await pool.query(
    `SELECT id, role, status, lifecycle_state FROM mesh_accounts WHERE national_id = $1`, [nationalId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'الحساب غير موجود' });
  const account = result.rows[0];
  if (['blocked', 'rejected'].includes(account.status)) {
    return res.status(403).json({ error: 'الحساب موقوف أو مرفوض' });
  }
  if (account.status !== 'active') {
    return res.status(403).json({ error: 'الحساب بانتظار اعتماد الإدارة أو اكتمال التحقق' });
  }
  res.json({ ok: true, message: 'تم تسجيل طلبك. اطلب رمز الدخول من الإدارة' });
}));

/* Verify one-time login code */
app.post('/api/auth/verify-code', asyncHandler(async (req, res) => {
  const nationalId = clean(req.body?.nationalId, 30);
  const code = clean(req.body?.code, 6);
  if (!validNationalId(nationalId) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'بيانات التحقق غير صحيحة' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const accountResult = await client.query(
      `SELECT * FROM mesh_accounts WHERE national_id = $1 FOR UPDATE`, [nationalId]
    );
    if (!accountResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الحساب غير موجود' });
    }
    const account = accountResult.rows[0];
    if (account.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: account.status === 'pending'
          ? 'الحساب بانتظار اعتماد الإدارة أو اكتمال التحقق'
          : 'الحساب غير مسموح له بالدخول'
      });
    }
    const otpResult = await client.query(
      `SELECT * FROM mesh_otp_requests
       WHERE account_id = $1 AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [account.id]
    );
    if (!otpResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'لا يوجد رمز صالح' });
    }
    const otp = otpResult.rows[0];
    if (new Date(otp.expires_at) < new Date() || otp.attempts >= 5) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'انتهت صلاحية الرمز' });
    }
    const validCode = await bcrypt.compare(code, otp.otp_hash);
    if (!validCode) {
      await client.query('UPDATE mesh_otp_requests SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
      await client.query('COMMIT');
      return res.status(400).json({ error: 'الرمز غير صحيح' });
    }
    await client.query('UPDATE mesh_otp_requests SET used_at = NOW() WHERE id = $1', [otp.id]);
    await client.query('UPDATE mesh_accounts SET last_activity_at = NOW() WHERE id = $1', [account.id]);
    await client.query('COMMIT');
    await audit(account.id, 'login', account.id);
    res.json({
      ok: true,
      token: signToken(account.id, account.role),
      account: {
        id: account.id, fullName: account.full_name, full_name: account.full_name,
        nationalId: account.national_id, phone: account.phone, role: account.role, status: account.status
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

/* Current account */
app.get('/api/me', auth, asyncHandler(async (req, res) => {
  if (!['passenger', 'driver'].includes(req.user.role)) {
    return res.status(403).json({ error: 'غير مسموح' });
  }
  const result = await pool.query(
    `SELECT a.id, a.national_id, a.full_name, a.phone, a.role, a.status,
       a.approval_mode, a.verification_status, p.customer_debt, p.is_blocked,
       d.car_type, d.car_model, d.car_color, d.plate_number, d.registration_number,
       d.vehicle_image_url, d.wallet_balance, d.withdrawable_balance, d.is_off_duty
     FROM mesh_accounts a
     LEFT JOIN mesh_passenger_profiles p ON p.account_id = a.id
     LEFT JOIN mesh_driver_profiles d ON d.account_id = a.id
     WHERE a.id = $1`, [req.user.sub]
  );
  if (!result.rowCount || result.rows[0].role !== req.user.role || result.rows[0].status !== 'active') {
    return res.status(403).json({ error: 'الحساب غير نشط أو الدور غير مطابق' });
  }
  const account = result.rows[0];
  account.fullName = account.full_name;
  account.nationalId = account.national_id;
  if (account.role === 'driver') {
    account.car_plate = account.plate_number;
    account.is_on_duty = !account.is_off_duty;
    account.isOnDuty = !account.is_off_duty;
    account.walletBalance = account.wallet_balance;
  }
  res.json({ account });
}));

/* Public application settings */
app.get('/api/settings', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT setting_key, setting_value FROM mesh_settings');
  res.json({
    settings: Object.fromEntries(result.rows.map(row => [row.setting_key, Number(row.setting_value)]))
  });
}));

/* Passenger creates a trip request */
app.post('/api/trips', auth, role('passenger'), asyncHandler(async (req, res) => {
  const destination = clean(req.body?.destination, 500);
  if (!destination) return res.status(400).json({ error: 'أدخل الوجهة' });
  const account = await pool.query(
    `SELECT status FROM mesh_accounts WHERE id = $1 AND role = 'passenger'`, [req.user.sub]
  );
  if (!account.rowCount || account.rows[0].status !== 'active') {
    return res.status(403).json({ error: 'الحساب غير نشط' });
  }
  const settings = await pool.query(
    `SELECT setting_key, setting_value FROM mesh_settings WHERE setting_key IN ('base_fare','per_km_rate')`
  );
  const config = Object.fromEntries(settings.rows.map(row => [row.setting_key, Number(row.setting_value)]));
  const distance = 5;
  const fare = (config.base_fare || 1000) + (config.per_km_rate || 300) * distance;
  const trip = await pool.query(
    `INSERT INTO mesh_trips(passenger_id, dropoff_address, distance_km, fare_amount)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.user.sub, destination, distance, fare]
  );
  res.status(201).json({ ok: true, trip: trip.rows[0], estimated: true });
}));

/* Driver duty state */
app.put('/api/driver/duty', auth, role('driver'), asyncHandler(async (req, res) => {
  let offDuty;
  if (typeof req.body?.offDuty === 'boolean') offDuty = req.body.offDuty;
  else if (typeof req.body?.is_on_duty === 'boolean') offDuty = !req.body.is_on_duty;
  else return res.status(400).json({ error: 'حالة الدوام غير صحيحة' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await client.query(
      `SELECT id, status FROM mesh_accounts WHERE id = $1 AND role = 'driver' FOR UPDATE`,
      [req.user.sub]
    );
    if (!account.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'حساب السائق غير موجود' });
    }
    if (account.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'السائق غير معتمد أو حسابه موقوف' });
    }
    const profile = await client.query(
      `UPDATE mesh_driver_profiles SET is_off_duty = $1 WHERE account_id = $2 RETURNING is_off_duty`,
      [offDuty, req.user.sub]
    );
    if (!profile.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'بيانات مركبة السائق غير موجودة' });
    }
    await client.query('COMMIT');
    res.json({ ok: true, offDuty, is_off_duty: offDuty, is_on_duty: !offDuty });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

/* Admin status: reveals only whether first-time setup is needed */
app.get('/api/admin/status', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT id FROM mesh_admin_auth WHERE id = 1');
  res.json({ setupRequired: !result.rowCount });
}));

/* Secure one-time first administrator setup */
app.post('/api/admin/setup', adminRecoveryLimiter, asyncHandler(async (req, res) => {
  const setupSecret = String(req.body?.setupSecret || '');
  const username = clean(req.body?.username, 100);
  const password = String(req.body?.password || '');
  const confirmation = String(req.body?.confirmation || '');

  if (!process.env.ADMIN_SETUP_SECRET || process.env.ADMIN_SETUP_SECRET.length < 32) {
    return res.status(503).json({ error: 'يلزم إعداد ADMIN_SETUP_SECRET في إعدادات الخادم أولاً' });
  }
  if (!safeEqual(setupSecret, process.env.ADMIN_SETUP_SECRET)) {
    return res.status(401).json({ error: 'رمز التهيئة غير صحيح' });
  }
  if (username.length < 3 || !validAdminPassword(password) || password !== confirmation) {
    return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل وكلمة المرور 12 حرفاً على الأقل مع تطابق التأكيد' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(741928361)');
    const exists = await client.query('SELECT id FROM mesh_admin_auth WHERE id = 1 FOR UPDATE');
    if (exists.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'تم إعداد حساب المدير مسبقاً. لا يمكن تكرار التهيئة' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const recoveryCode = crypto.randomBytes(24).toString('base64url');
    const recoveryHash = await bcrypt.hash(recoveryCode, 12);
    const inserted = await client.query(
      `INSERT INTO mesh_admin_auth(id, username, password_hash, recovery_hash)
       VALUES (1,$1,$2,$3) RETURNING token_version`,
      [username, passwordHash, recoveryHash]
    );
    await client.query('COMMIT');
    await audit(null, 'admin_initial_setup', null, { username });
    res.status(201).json({
      ok: true,
      token: signToken('admin', 'admin', inserted.rows[0].token_version),
      recoveryCode,
      message: 'احفظ رمز الاستعادة الآن؛ لن يظهر مرة أخرى.'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'اسم المستخدم مستخدم مسبقاً' });
    throw error;
  } finally {
    client.release();
  }
}));

/* Administration login */
app.post('/api/admin/login', adminLoginLimiter, asyncHandler(async (req, res) => {
  const username = clean(req.body?.username, 100);
  const password = String(req.body?.password || '');
  const result = await pool.query(
    `SELECT username, password_hash, token_version
     FROM mesh_admin_auth WHERE id = 1`
  );
  if (!result.rowCount) {
    return res.status(403).json({ error: 'يلزم إعداد حساب المدير أولاً' });
  }
  const admin = result.rows[0];
  const valid = username === admin.username && await bcrypt.compare(password, admin.password_hash);
  if (!valid) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  res.json({ ok: true, token: signToken('admin', 'admin', admin.token_version) });
}));

/* Password change: current password required; all previous admin tokens revoked */
app.put('/api/admin/password', auth, role('admin'), asyncHandler(async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  const confirmation = String(req.body?.confirmation || '');
  if (!validAdminPassword(newPassword) || newPassword !== confirmation) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 12 حرفاً على الأقل وأن يتطابق التأكيد' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT username, password_hash, token_version
       FROM mesh_admin_auth WHERE id = 1 FOR UPDATE`
    );
    if (!result.rowCount || !await bcrypt.compare(currentPassword, result.rows[0].password_hash)) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    const updated = await client.query(
      `UPDATE mesh_admin_auth
       SET password_hash = $1, token_version = token_version + 1, updated_at = NOW()
       WHERE id = 1 RETURNING token_version`,
      [hash]
    );
    await client.query('COMMIT');
    await audit(null, 'admin_password_changed', null);
    res.json({
      ok: true,
      token: signToken('admin', 'admin', updated.rows[0].token_version),
      message: 'تم تغيير كلمة المرور. تم إنهاء الجلسات القديمة.'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

/* Generate/rotate a one-time recovery code after verifying current password */
app.post('/api/admin/recovery-code', auth, role('admin'), asyncHandler(async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT password_hash FROM mesh_admin_auth WHERE id = 1 FOR UPDATE`
    );
    if (!result.rowCount || !await bcrypt.compare(currentPassword, result.rows[0].password_hash)) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
    }
    const recoveryCode = crypto.randomBytes(24).toString('base64url');
    const recoveryHash = await bcrypt.hash(recoveryCode, 12);
    await client.query(
      `UPDATE mesh_admin_auth SET recovery_hash = $1, updated_at = NOW() WHERE id = 1`,
      [recoveryHash]
    );
    await client.query('COMMIT');
    await audit(null, 'admin_recovery_code_rotated', null);
    res.json({
      ok: true, recoveryCode,
      message: 'احفظ الرمز في مكان آمن؛ لن يظهر مرة أخرى.'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

/* Emergency recovery-code bootstrap using the server owner's setup secret.
   It only works when no recovery code is currently stored. */
app.post('/api/admin/recovery-bootstrap', adminRecoveryLimiter, asyncHandler(async (req, res) => {
  const setupSecret = String(req.body?.setupSecret || '');
  const username = clean(req.body?.username, 100);
  const configuredSecret = process.env.ADMIN_SETUP_SECRET || '';

  if (configuredSecret.length < 32 || !safeEqual(setupSecret, configuredSecret)) {
    return res.status(401).json({ error: 'تعذر إصدار رمز الاستعادة. تحقق من البيانات ومفتاح المالك' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'أدخل اسم المستخدم الصحيح' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT username, recovery_hash FROM mesh_admin_auth WHERE id = 1 FOR UPDATE`
    );
    if (!result.rowCount || result.rows[0].username !== username || result.rows[0].recovery_hash) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'تعذر إصدار رمز الاستعادة. تحقق من البيانات ومفتاح المالك' });
    }

    const recoveryCode = crypto.randomBytes(24).toString('base64url');
    const recoveryHash = await bcrypt.hash(recoveryCode, 12);
    await client.query(
      `UPDATE mesh_admin_auth SET recovery_hash = $1, updated_at = NOW() WHERE id = 1`,
      [recoveryHash]
    );
    await client.query('COMMIT');
    await audit(null, 'admin_recovery_code_bootstrapped', null);
    return res.json({
      ok: true,
      recoveryCode,
      message: 'احفظ الرمز الآن؛ لن يظهر مرة أخرى.'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

/* Password recovery: one-time recovery code is consumed on success */
app.post('/api/admin/recover', adminRecoveryLimiter, asyncHandler(async (req, res) => {
  const username = clean(req.body?.username, 100);
  const recoveryCode = String(req.body?.recoveryCode || '');
  const newPassword = String(req.body?.newPassword || '');
  const confirmation = String(req.body?.confirmation || '');
  if (!validAdminPassword(newPassword) || newPassword !== confirmation) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 12 حرفاً على الأقل وأن يتطابق التأكيد' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT username, recovery_hash FROM mesh_admin_auth WHERE id = 1 FOR UPDATE`
    );
    if (!result.rowCount || result.rows[0].username !== username ||
        !result.rows[0].recovery_hash ||
        !await bcrypt.compare(recoveryCode, result.rows[0].recovery_hash)) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'اسم المستخدم أو رمز الاستعادة غير صحيح' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await client.query(
      `UPDATE mesh_admin_auth
       SET password_hash = $1, recovery_hash = NULL,
           token_version = token_version + 1, updated_at = NOW()
       WHERE id = 1`,
      [hash]
    );
    await client.query('COMMIT');
    await audit(null, 'admin_password_recovered', null);
    res.json({ ok: true, message: 'تمت استعادة كلمة المرور. يمكنك تسجيل الدخول الآن.' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

/* Admin approval policies */
app.get('/api/admin/approval-policies', auth, role('admin'), asyncHandler(async (req, res) => {
  const policies = await getApprovalPolicies();
  res.json({
    policies, automaticVerificationReady: false,
    notice: 'الاعتماد التلقائي لن يفعّل الحساب قبل ربط نظام التحقق الآلي من الوثائق.'
  });
}));

app.put('/api/admin/approval-policies', auth, role('admin'), asyncHandler(async (req, res) => {
  const passenger = req.body?.passenger;
  const driver = req.body?.driver;
  if (!['manual', 'automatic'].includes(passenger) || !['manual', 'automatic'].includes(driver)) {
    return res.status(400).json({ error: 'اختر سياسة صحيحة لكل نوع حساب' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO mesh_settings(setting_key, setting_value, updated_at)
       VALUES ('passenger_approval_mode',$1,NOW()), ('driver_approval_mode',$2,NOW())
       ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
      [passenger, driver]
    );
    await client.query('COMMIT');
    await audit(null, 'approval_policies_updated', null, { passenger, driver });
    res.json({
      ok: true, policies: { passenger, driver }, automaticVerificationReady: false,
      notice: 'تم حفظ الإعدادات. التفعيل التلقائي ينتظر ربط التحقق الآلي من الوثائق.'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

/* Administration overview */
app.get('/api/admin/overview', auth, role('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM mesh_accounts WHERE role = 'passenger') passengers,
      (SELECT COUNT(*) FROM mesh_accounts WHERE role = 'driver') drivers,
      (SELECT COUNT(*) FROM mesh_accounts WHERE role = 'driver' AND status = 'active') active_drivers,
      (SELECT COUNT(*) FROM mesh_accounts WHERE status = 'pending' AND lifecycle_state = 'open') pending_accounts,
      (SELECT COUNT(*) FROM mesh_accounts WHERE lifecycle_state = 'open' AND status = 'active'
        AND last_activity_at < NOW() - INTERVAL '6 months') inactive_accounts,
      (SELECT COUNT(*) FROM mesh_accounts WHERE lifecycle_state = 'suspended') suspended_accounts,
      (SELECT COUNT(*) FROM mesh_accounts WHERE lifecycle_state = 'closed') closed_accounts,
      (SELECT COUNT(*) FROM mesh_trips) trips
  `);
  res.json({ overview: result.rows[0] });
}));

/* Administration accounts */
app.get('/api/admin/accounts', auth, role('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT a.id, a.national_id, a.full_name, a.phone, a.role, a.status,
      a.approval_mode, a.verification_status, a.created_at,
      a.last_activity_at, a.lifecycle_state, a.closed_at, a.closure_reason,
      (a.lifecycle_state = 'open' AND a.status = 'active'
        AND a.last_activity_at < NOW() - INTERVAL '6 months') AS is_inactive,
      d.car_type, d.car_model, d.car_color, d.plate_number,
      d.registration_number, d.wallet_balance
    FROM mesh_accounts a
    LEFT JOIN mesh_driver_profiles d ON d.account_id = a.id
    ORDER BY a.created_at DESC
  `);
  res.json({ accounts: result.rows });
}));

/* Account lifecycle: inactivity is computed from last_activity_at, not a destructive status change. */
app.patch('/api/admin/accounts/:id/lifecycle', auth, role('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const action = clean(req.body?.action, 30);
  const reason = clean(req.body?.reason, 1000);
  const confirmation = clean(req.body?.confirmation, 30);
  if (!Number.isSafeInteger(id) || id < 1 || !['suspend', 'reactivate', 'close'].includes(action)) {
    return res.status(400).json({ error: 'بيانات العملية غير صحيحة' });
  }
  if (['suspend', 'close'].includes(action) && reason.length < 3) {
    return res.status(400).json({ error: 'أدخل سبباً واضحاً للعملية' });
  }
  if (action === 'close' && confirmation !== 'CLOSE') {
    return res.status(400).json({ error: 'تأكيد إغلاق الحساب غير مكتمل' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id, role, status, lifecycle_state FROM mesh_accounts WHERE id = $1 FOR UPDATE`, [id]
    );
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الحساب غير موجود' });
    }
    const account = found.rows[0];
    if (account.lifecycle_state === 'anonymized') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'تم إخفاء البيانات الشخصية لهذا الحساب ولا يمكن تعديل حالته' });
    }

    let updated;
    if (action === 'suspend') {
      if (account.lifecycle_state !== 'open') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'الحساب ليس في الحالة النشطة' });
      }
      updated = await client.query(
        `UPDATE mesh_accounts SET lifecycle_state = 'suspended',
           status_before_block = status, status = 'blocked', updated_at = NOW()
         WHERE id = $1 RETURNING id, status, lifecycle_state`, [id]
      );
      if (account.role === 'driver') {
        await client.query('UPDATE mesh_driver_profiles SET is_off_duty = TRUE WHERE account_id = $1', [id]);
      }
      await client.query('DELETE FROM mesh_otp_requests WHERE account_id = $1', [id]);
      await client.query(
        `INSERT INTO mesh_audit_logs(actor_id, action, target_id, details)
         VALUES (NULL, 'account_suspended', $1, $2::jsonb)`, [id, JSON.stringify({ reason })]
      );
    } else if (action === 'reactivate') {
      if (account.lifecycle_state !== 'suspended') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'يمكن إعادة تفعيل الحسابات الموقوفة مؤقتاً فقط' });
      }
      updated = await client.query(
        `UPDATE mesh_accounts SET lifecycle_state = 'open',
           status = COALESCE(status_before_block, 'active'), status_before_block = NULL,
           last_activity_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING id, status, lifecycle_state`, [id]
      );
      await client.query(
        `INSERT INTO mesh_audit_logs(actor_id, action, target_id, details)
         VALUES (NULL, 'account_reactivated', $1, '{}'::jsonb)`, [id]
      );
    } else {
      if (['closed', 'anonymized'].includes(account.lifecycle_state)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'الحساب مغلق مسبقاً' });
      }
      updated = await client.query(
        `UPDATE mesh_accounts SET lifecycle_state = 'closed', status = 'blocked',
           closed_at = NOW(), closure_reason = $2, updated_at = NOW()
         WHERE id = $1 RETURNING id, status, lifecycle_state`, [id, reason]
      );
      if (account.role === 'driver') {
        await client.query('UPDATE mesh_driver_profiles SET is_off_duty = TRUE WHERE account_id = $1', [id]);
      }
      await client.query('DELETE FROM mesh_otp_requests WHERE account_id = $1', [id]);
      await client.query(
        `INSERT INTO mesh_audit_logs(actor_id, action, target_id, details)
         VALUES (NULL, 'account_closed', $1, $2::jsonb)`, [id, JSON.stringify({ reason })]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, account: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

/* Final privacy deletion: anonymize PII and profiles while retaining trip/account references. */
app.post('/api/admin/accounts/:id/anonymize', auth, role('admin'), adminRecoveryLimiter, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const reason = clean(req.body?.reason, 1000);
  const currentPassword = String(req.body?.currentPassword || '');
  const confirmation = clean(req.body?.confirmation, 30);
  if (!Number.isSafeInteger(id) || id < 1 || reason.length < 3 || confirmation !== 'DELETE') {
    return res.status(400).json({ error: 'تأكد من المعرف والسبب واكتب DELETE للتأكيد' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const admin = await client.query(
      'SELECT password_hash FROM mesh_admin_auth WHERE id = 1 FOR UPDATE'
    );
    if (!admin.rowCount || !await bcrypt.compare(currentPassword, admin.rows[0].password_hash)) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'كلمة مرور المدير الحالية غير صحيحة' });
    }
    const found = await client.query(
      `SELECT id, lifecycle_state FROM mesh_accounts WHERE id = $1 FOR UPDATE`, [id]
    );
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الحساب غير موجود' });
    }
    if (found.rows[0].lifecycle_state !== 'closed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'يجب إغلاق الحساب أولاً قبل حذف بياناته نهائياً' });
    }

    await client.query('DELETE FROM mesh_otp_requests WHERE account_id = $1', [id]);
    await client.query('DELETE FROM mesh_passenger_profiles WHERE account_id = $1', [id]);
    await client.query('DELETE FROM mesh_driver_profiles WHERE account_id = $1', [id]);
    await client.query(
      `UPDATE mesh_accounts SET national_id = NULL, full_name = 'حساب محذوف', phone = '',
         lifecycle_state = 'anonymized', anonymized_at = NOW(), anonymization_reason = $2,
         closure_reason = COALESCE(closure_reason, $2), status = 'blocked',
         status_before_block = NULL, updated_at = NOW()
       WHERE id = $1`, [id, reason]
    );
    await client.query(
      `INSERT INTO mesh_audit_logs(actor_id, action, target_id, details)
       VALUES (NULL, 'account_personal_data_anonymized', $1, $2::jsonb)`,
      [id, JSON.stringify({ reason, tripsRetained: true, accountReferenceRetained: true })]
    );
    await client.query('COMMIT');
    res.json({
      ok: true,
      message: 'تم إخفاء البيانات الشخصية وحذف ملفات الحساب ورموز الدخول. تم الاحتفاظ بسجل الحساب المرتبط بالرحلات وسجلات التدقيق.',
      retained: ['سجل الرحلات والمبالغ والحالات', 'مرجع الحساب اللازم لسلامة العلاقات', 'سجل التدقيق']
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

/* Admin issues one-time code */
app.post('/api/admin/accounts/:id/issue-code', auth, role('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'معرف غير صحيح' });
  const account = await pool.query(
    `SELECT id, role, status FROM mesh_accounts WHERE id = $1`, [id]
  );
  if (!account.rowCount) return res.status(404).json({ error: 'الحساب غير موجود' });
  if (account.rows[0].status !== 'active') return res.status(403).json({ error: 'اعتمد الحساب أولاً' });

  const code = String(crypto.randomInt(100000, 1000000));
  const hash = await bcrypt.hash(code, 12);
  await pool.query(
    `INSERT INTO mesh_otp_requests(account_id, otp_hash, expires_at)
     VALUES ($1,$2,NOW() + INTERVAL '5 minutes')`, [id, hash]
  );
  await audit(null, 'issue_code', id);
  res.json({ ok: true, code, expiresInSeconds: 300 });
}));

/* Admin changes driver status */
app.patch('/api/admin/drivers/:id/status', auth, role('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const status = clean(req.body?.status, 20);
  if (!Number.isSafeInteger(id) || !['active', 'rejected', 'blocked'].includes(status)) {
    return res.status(400).json({ error: 'بيانات غير صحيحة' });
  }
  const result = await pool.query(
    `UPDATE mesh_accounts SET status = $1, updated_at = NOW()
     WHERE id = $2 AND role = 'driver' RETURNING id, status`, [status, id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'السائق غير موجود' });
  if (status !== 'active') {
    await pool.query('UPDATE mesh_driver_profiles SET is_off_duty = TRUE WHERE account_id = $1', [id]);
  }
  await audit(null, 'driver_status', id, { status });
  res.json({ ok: true, account: result.rows[0] });
}));

/* Admin changes passenger status */
app.patch('/api/admin/passengers/:id/status', auth, role('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const status = clean(req.body?.status, 20);
  if (!Number.isSafeInteger(id) || !['active', 'blocked', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'بيانات غير صحيحة' });
  }
  const result = await pool.query(
    `UPDATE mesh_accounts SET status = $1, updated_at = NOW()
     WHERE id = $2 AND role = 'passenger' RETURNING id, status`, [status, id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'الراكب غير موجود' });
  await audit(null, 'passenger_status', id, { status });
  res.json({ ok: true, account: result.rows[0] });
}));

/* Administration trips */
app.get('/api/admin/trips', auth, role('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT t.*, p.full_name AS passenger_name, d.full_name AS driver_name
    FROM mesh_trips t
    JOIN mesh_accounts p ON p.id = t.passenger_id
    LEFT JOIN mesh_accounts d ON d.id = t.driver_id
    ORDER BY t.created_at DESC LIMIT 500
  `);
  res.json({ trips: result.rows });
}));

/* Administration audit log */
app.get('/api/admin/audit', auth, role('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM mesh_audit_logs ORDER BY created_at DESC LIMIT 500`
  );
  res.json({ logs: result.rows });
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('API error:', err.message);
  if (res.headersSent) return next(err);
  res.status(err.message === 'Origin not allowed' ? 403 : 500).json({
    error: err.message === 'Origin not allowed'
      ? 'المصدر غير مسموح'
      : 'حدث خطأ داخلي في الخادم'
  });
});

(async () => {
  try {
    await initDb();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Meshwari API listening on ${PORT}`);
    });
  } catch (error) {
    console.error('Database startup failed:', error);
    process.exit(1);
  }
})();
