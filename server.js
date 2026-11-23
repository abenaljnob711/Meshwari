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
const { pointInGeoJSON, validatePolygonGeoJSON } = require('./lib/service-coverage');
const { createTripCallIceServers } = require('./lib/trip-call-utils');
const { sendFirebasePush } = require('./lib/firebase-push');
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
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 900,
  standardHeaders: true, legacyHeaders: false
});
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'طلبات كثيرة. حاول بعد 15 دقيقة' }
});
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'محاولات كثيرة. حاول بعد 15 دقيقة' }
});
const usedAdminUnlockChallenges = new Map();
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

function pushRecipient(req) {
  if (req.user.role === 'admin') return { type: 'admin', id: String(req.user.sub) };
  return { type: req.user.role, id: String(req.user.sub) };
}
async function saveAndSendNotification(recipient, notification) {
  const saved = await pool.query(
    `INSERT INTO mesh_notifications(recipient_type,recipient_id,notification_type,title,body,data)
     VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
    [recipient.type, recipient.id, notification.type, notification.title, notification.body, JSON.stringify(notification.data || {})]
  );
  const devices = await pool.query('SELECT id,device_token FROM mesh_push_devices WHERE recipient_type=$1 AND recipient_id=$2', [recipient.type, recipient.id]);
  for (const device of devices.rows) {
    try {
      const result = await sendFirebasePush({token:device.device_token,title:notification.title,body:notification.body,data:{...notification.data,notificationId:saved.rows[0].id,type:notification.type}});
      if (result.invalidToken) await pool.query('DELETE FROM mesh_push_devices WHERE id=$1', [device.id]);
    } catch (error) { console.error('Push delivery failed:', error.message); }
  }
  return saved.rows[0].id;
}
async function notifyAllAdmins(notification) {
  const devices = await pool.query("SELECT DISTINCT recipient_id FROM mesh_push_devices WHERE recipient_type='admin'");
  const recipients = devices.rows.map(row => ({type:'admin',id:row.recipient_id}));
  const owner = await pool.query('SELECT 1 FROM mesh_admin_auth WHERE id=1');
  if (owner.rowCount && !recipients.some(item=>item.id==='admin')) recipients.push({type:'admin',id:'admin'});
  for (const recipient of recipients) await saveAndSendNotification(recipient, notification);
}
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
    { expiresIn: accountRole === 'admin' ? '4h' : '30d' }
  );

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (decoded.role === 'admin') {
      if (decoded.sub === 'admin') {
        const owner = await pool.query('SELECT token_version FROM mesh_admin_auth WHERE id = 1');
        if (!owner.rowCount || Number(decoded.ver) !== Number(owner.rows[0].token_version)) {
          return res.status(401).json({ error: 'انتهت صلاحية الجلسة. سجل الدخول مجدداً' });
        }
        req.user = { ...decoded, isOwner: true, permissions: ['*'], adminId: 1 };
      } else {
        const match = /^admin:(\d+)$/.exec(String(decoded.sub || ''));
        if (!match) return res.status(401).json({ error: 'جلسة المدير غير صالحة' });
        const result = await pool.query(
          `SELECT id, username, permissions, token_version, is_active
           FROM mesh_admin_users WHERE id = $1`, [match[1]]
        );
        if (!result.rowCount || !result.rows[0].is_active || Number(decoded.ver) !== Number(result.rows[0].token_version)) {
          return res.status(401).json({ error: 'تم إيقاف حساب المدير أو انتهت جلسته' });
        }
        req.user = { ...decoded, isOwner: false, adminId: Number(result.rows[0].id),
          username: result.rows[0].username, permissions: result.rows[0].permissions || [] };
      }
    } else if (['passenger', 'driver'].includes(decoded.role)) {
      const account = await pool.query(
        `UPDATE mesh_accounts SET last_activity_at = NOW()
         WHERE id = $1 AND role = $2 AND status = 'active' AND lifecycle_state = 'open' AND deleted_at IS NULL
         RETURNING id`, [decoded.sub, decoded.role]
      );
      if (!account.rowCount) return res.status(403).json({ error: 'الحساب موقوف أو مغلق أو غير معتمد' });
      req.user = decoded;
    } else {
      req.user = decoded;
    }
    return next();
  } catch (error) {
    if (error && (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError')) {
      return res.status(401).json({ error: 'الجلسة غير صالحة، سجل الدخول مجدداً' });
    }
    return next(error);
  }
}

const adminPermissionForRequest = req => {
  const path = req.path || '';
  const method = String(req.method || 'GET').toUpperCase();
  if (path === '/admin/whatsapp/settings') return 'manage_whatsapp_settings';
  if (path === '/admin/whatsapp/test') return 'manage_whatsapp_settings';
  if (path === '/admin/accounts' && method === 'GET') return 'issue_otp';
  if (path === '/admin/otp-eligible-accounts') return 'issue_otp';
  if (/^\/admin\/accounts\/\d+\/issue-code$/.test(path) && method === 'POST') return 'issue_otp';
  if (path === '/admin/me') return null;
  return '__owner_only__';
};

const role = (...allowed) => (req, res, next) => {
  if (!req.user || !allowed.includes(req.user.role)) return res.status(403).json({ error: 'ليس لديك صلاحية' });
  if (req.user.role === 'admin' && !req.user.isOwner) {
    const needed = adminPermissionForRequest(req);
    if (needed === '__owner_only__' || (needed && !req.user.permissions.includes(needed))) {
      return res.status(403).json({ error: 'هذه العملية غير مشمولة بصلاحيات حسابك' });
    }
  }
  next();
};

const adminActorId = req => req.user?.isOwner ? 1 : (req.user?.adminId || null);

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
     WHERE setting_key IN ('passenger_approval_mode','driver_approval_mode','driver_registration_number_required')`
  );
  const values = Object.fromEntries(result.rows.map(row => [row.setting_key, row.setting_value]));
  return {
    passenger: values.passenger_approval_mode === 'automatic' ? 'automatic' : DEFAULT_APPROVAL_POLICIES.passenger,
    driver: values.driver_approval_mode === 'automatic' ? 'automatic' : DEFAULT_APPROVAL_POLICIES.driver,
    driverRegistrationNumberRequired: values.driver_registration_number_required !== 'false'
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
    ALTER TABLE mesh_accounts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE mesh_accounts ADD COLUMN IF NOT EXISTS deleted_reason TEXT;
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
    CREATE TABLE IF NOT EXISTS mesh_driver_vehicles (
      id BIGSERIAL PRIMARY KEY,
      driver_id BIGINT NOT NULL REFERENCES mesh_accounts(id) ON DELETE CASCADE,
      car_type VARCHAR(100) NOT NULL,
      car_model VARCHAR(100) NOT NULL,
      car_color VARCHAR(60) NOT NULL,
      plate_number VARCHAR(50) NOT NULL,
      registration_number VARCHAR(80) NOT NULL,
      vehicle_image_url TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','replaced','removed')),
      is_current BOOLEAN NOT NULL DEFAULT FALSE,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      review_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS mesh_driver_vehicles_driver_idx
      ON mesh_driver_vehicles(driver_id, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS mesh_driver_vehicles_pending_idx
      ON mesh_driver_vehicles(status, submitted_at DESC);
    -- Preserve the vehicle already in use when this history table is introduced.
    INSERT INTO mesh_driver_vehicles
      (driver_id, car_type, car_model, car_color, plate_number, registration_number,
       vehicle_image_url, status, is_current)
    SELECT d.account_id, d.car_type, d.car_model, d.car_color, d.plate_number,
      d.registration_number, d.vehicle_image_url,
      'approved', TRUE
    FROM mesh_driver_profiles d
    JOIN mesh_accounts a ON a.id = d.account_id
    WHERE a.lifecycle_state <> 'anonymized' AND NOT EXISTS (
      SELECT 1 FROM mesh_driver_vehicles v WHERE v.driver_id = d.account_id
    );

    CREATE TABLE IF NOT EXISTS mesh_push_devices (
      id BIGSERIAL PRIMARY KEY,
      recipient_type VARCHAR(20) NOT NULL CHECK (recipient_type IN ('passenger','driver','admin')),
      recipient_id VARCHAR(80) NOT NULL,
      device_token TEXT NOT NULL UNIQUE,
      platform VARCHAR(20) NOT NULL DEFAULT 'android',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS mesh_push_devices_recipient_idx ON mesh_push_devices(recipient_type, recipient_id);
    CREATE TABLE IF NOT EXISTS mesh_notifications (
      id BIGSERIAL PRIMARY KEY,
      recipient_type VARCHAR(20) NOT NULL CHECK (recipient_type IN ('passenger','driver','admin')),
      recipient_id VARCHAR(80) NOT NULL,
      notification_type VARCHAR(60) NOT NULL,
      title VARCHAR(180) NOT NULL,
      body TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS mesh_notifications_recipient_idx ON mesh_notifications(recipient_type, recipient_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS mesh_driver_wallet_transactions (
      id BIGSERIAL PRIMARY KEY,
      driver_id BIGINT NOT NULL REFERENCES mesh_accounts(id),
      amount NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
      balance_after NUMERIC(12,2) NOT NULL,
      transaction_type VARCHAR(40) NOT NULL,
      description TEXT NOT NULL,
      reference_key VARCHAR(160) UNIQUE,
      created_by VARCHAR(80),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS mesh_driver_wallet_history_idx
      ON mesh_driver_wallet_transactions(driver_id,created_at DESC,id DESC);
    INSERT INTO mesh_driver_wallet_transactions(driver_id,amount,balance_after,transaction_type,description,reference_key)
    SELECT d.account_id,d.wallet_balance,d.wallet_balance,'opening_balance','الرصيد الافتتاحي قبل تفعيل سجل المحفظة','opening:'||d.account_id
    FROM mesh_driver_profiles d
    WHERE d.wallet_balance<>0 AND NOT EXISTS (
      SELECT 1 FROM mesh_driver_wallet_transactions w WHERE w.reference_key='opening:'||d.account_id
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
    ALTER TABLE mesh_driver_profiles ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
    ALTER TABLE mesh_driver_profiles ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
    ALTER TABLE mesh_driver_profiles ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;
    ALTER TABLE mesh_trips ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid';
    ALTER TABLE mesh_trips ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
    ALTER TABLE mesh_trips ADD COLUMN IF NOT EXISTS stops JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS mesh_driver_location_idx
      ON mesh_driver_profiles(is_off_duty, location_updated_at DESC);
    CREATE INDEX IF NOT EXISTS mesh_trips_driver_status_idx
      ON mesh_trips(driver_id, status, created_at DESC);
    CREATE TABLE IF NOT EXISTS mesh_trip_calls (
      id BIGSERIAL PRIMARY KEY,
      trip_id BIGINT NOT NULL REFERENCES mesh_trips(id) ON DELETE CASCADE,
      caller_id BIGINT NOT NULL REFERENCES mesh_accounts(id) ON DELETE CASCADE,
      callee_id BIGINT NOT NULL REFERENCES mesh_accounts(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'ringing'
        CHECK (status IN ('ringing','accepted','rejected','ended','expired')),
      offer_sdp TEXT NOT NULL,
      answer_sdp TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '60 seconds')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS mesh_trip_calls_one_active_idx
      ON mesh_trip_calls(trip_id) WHERE status IN ('ringing','accepted');
    CREATE INDEX IF NOT EXISTS mesh_trip_calls_expiry_idx
      ON mesh_trip_calls(status, expires_at);
    CREATE TABLE IF NOT EXISTS mesh_trip_call_ice (
      id BIGSERIAL PRIMARY KEY,
      call_id BIGINT NOT NULL REFERENCES mesh_trip_calls(id) ON DELETE CASCADE,
      sender_id BIGINT NOT NULL REFERENCES mesh_accounts(id) ON DELETE CASCADE,
      candidate JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS mesh_trip_call_ice_cursor_idx
      ON mesh_trip_call_ice(call_id, id);
    CREATE TABLE IF NOT EXISTS mesh_trip_messages (
      id BIGSERIAL PRIMARY KEY,
      trip_id BIGINT NOT NULL REFERENCES mesh_trips(id) ON DELETE CASCADE,
      sender_id BIGINT NOT NULL REFERENCES mesh_accounts(id) ON DELETE CASCADE,
      message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
    );
    ALTER TABLE mesh_trip_messages ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '10 years');
    CREATE INDEX IF NOT EXISTS mesh_trip_messages_expiry_idx
      ON mesh_trip_messages(trip_id, expires_at, created_at);

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

    CREATE TABLE IF NOT EXISTS mesh_service_countries (
      country_code CHAR(2) PRIMARY KEY,
      country_name VARCHAR(120) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mesh_service_areas (
      id BIGSERIAL PRIMARY KEY,
      country_code CHAR(2) NOT NULL REFERENCES mesh_service_countries(country_code),
      region_name VARCHAR(160) NOT NULL,
      geojson JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS mesh_service_areas_country_idx
      ON mesh_service_areas(country_code, enabled);

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
      lock_method VARCHAR(20) NOT NULL DEFAULT 'password',
      lock_secret_hash TEXT,
      token_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mesh_admin_users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      permissions TEXT[] NOT NULL DEFAULT '{}',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      token_version INTEGER NOT NULL DEFAULT 1,
      created_by BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Keep delegated-admin audit IDs distinct from the legacy owner actor ID (1).
    SELECT setval(pg_get_serial_sequence('mesh_admin_users','id'),
      GREATEST(COALESCE((SELECT MAX(id) FROM mesh_admin_users), 0), 999999), TRUE);

    ALTER TABLE mesh_admin_auth
      ADD COLUMN IF NOT EXISTS lock_method VARCHAR(20) NOT NULL DEFAULT 'password';

    ALTER TABLE mesh_admin_auth
      ADD COLUMN IF NOT EXISTS lock_secret_hash TEXT;

    INSERT INTO mesh_settings(setting_key, setting_value)
    VALUES ('base_fare','1000'), ('per_km_rate','300'),
      ('passenger_approval_mode','manual'), ('driver_approval_mode','manual'),
      ('whatsapp_otp_enabled','false'), ('whatsapp_otp_template',''), ('whatsapp_otp_language','ar')
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
  res.json({
    ok: true,
    service: 'Meshwari API',
    database: 'connected',
    voiceCalls: {
      signaling: 'available',
      turnRelayConfigured: Boolean(process.env.TURN_URLS && process.env.TURN_SHARED_SECRET)
    },
    pushNotificationsConfigured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  });
}));

/* Registration */
app.post('/api/register', asyncHandler(async (req, res) => {
  const requestedRole = req.body?.role;
  const appRole = clean(req.body?.appRole, 20);
  const nationalId = clean(req.body?.nationalId, 30);
  const fullName = clean(req.body?.fullName, 150);
  const phone = clean(req.body?.phone, 40);

  if (!['passenger', 'driver'].includes(requestedRole) ||
      (appRole && (!['passenger', 'driver'].includes(appRole) || appRole !== requestedRole)) ||
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
      if (carValues.slice(0, 4).some(value => !value) ||
          (policies.driverRegistrationNumberRequired && !carValues[4])) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: policies.driverRegistrationNumberRequired
          ? 'أكمل بيانات السيارة والملكية واللوحة' : 'أكمل بيانات السيارة واللوحة' });
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
app.post('/api/auth/request-code', otpRequestLimiter, asyncHandler(async (req, res) => {
  const nationalId = clean(req.body?.nationalId, 30);
  if (!validNationalId(nationalId)) return res.status(400).json({ error: 'رقم البطاقة غير صحيح' });

  const result = await pool.query(
    `SELECT id, role, status, lifecycle_state FROM mesh_accounts WHERE national_id = $1`, [nationalId]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'الحساب غير موجود' });
  const account = result.rows[0];
  const appRole = clean(req.body?.appRole, 20);
  if (appRole && !['passenger', 'driver'].includes(appRole)) return res.status(400).json({ error: 'نوع التطبيق غير صحيح' });
  if (appRole && account.role !== appRole) return res.status(403).json({ error: appRole === 'passenger' ? 'هذا الحساب مخصص لتطبيق السائق' : 'هذا الحساب مخصص لتطبيق الراكب' });
  if (account.lifecycle_state !== 'open') {
    return res.status(403).json({ error: 'الحساب مغلق أو موقوف ولا يمكن طلب رمز دخول' });
  }
  if (['blocked', 'rejected'].includes(account.status)) {
    return res.status(403).json({ error: 'الحساب موقوف أو مرفوض' });
  }
  if (account.status !== 'active') {
    return res.status(403).json({ error: 'الحساب بانتظار اعتماد الإدارة أو اكتمال التحقق' });
  }
  try {
    await notifyAllAdmins({type:'otp_request',title:'طلب رمز تأكيد جديد',
      body:'يوجد طلب رمز دخول جديد للحساب '+String(account.id)+' ('+account.role+')',
      data:{accountId:account.id,role:account.role,screen:'otp'}});
  } catch (error) { console.error('Administrator OTP notification failed:', error.message); }
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
    const appRole = clean(req.body?.appRole, 20);
    if (appRole && !['passenger', 'driver'].includes(appRole)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'نوع التطبيق غير صحيح' });
    }
    if (appRole && account.role !== appRole) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: appRole === 'passenger' ? 'هذا الحساب مخصص لتطبيق السائق' : 'هذا الحساب مخصص لتطبيق الراكب' });
    }
    if (account.lifecycle_state !== 'open') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'الحساب مغلق أو موقوف ولا يمكن تسجيل الدخول' });
    }
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
       d.vehicle_image_url, d.wallet_balance, d.withdrawable_balance, d.is_off_duty,
       (SELECT COUNT(*) FROM mesh_driver_vehicles v WHERE v.driver_id = a.id) AS vehicle_count,
       (SELECT v.status FROM mesh_driver_vehicles v WHERE v.driver_id = a.id AND v.status = 'pending' ORDER BY v.submitted_at DESC LIMIT 1) AS pending_vehicle_status
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


app.post('/api/notifications/devices', auth, asyncHandler(async (req,res)=>{
  const token=clean(req.body?.token,4096), platform=clean(req.body?.platform||'android',20);
  if(token.length<20||!['android','ios','web'].includes(platform))return res.status(400).json({error:'رمز الجهاز أو نوع المنصة غير صحيح'});
  const recipient=pushRecipient(req);
  await pool.query(`INSERT INTO mesh_push_devices(recipient_type,recipient_id,device_token,platform)
    VALUES($1,$2,$3,$4) ON CONFLICT(device_token) DO UPDATE SET recipient_type=EXCLUDED.recipient_type,
    recipient_id=EXCLUDED.recipient_id,platform=EXCLUDED.platform,updated_at=NOW(),last_seen_at=NOW()`,
    [recipient.type,recipient.id,token,platform]);
  res.json({ok:true});
}));
app.delete('/api/notifications/devices', auth, asyncHandler(async (req,res)=>{
  const token=clean(req.body?.token,4096),recipient=pushRecipient(req);
  if(token)await pool.query('DELETE FROM mesh_push_devices WHERE device_token=$1 AND recipient_type=$2 AND recipient_id=$3',[token,recipient.type,recipient.id]);
  res.json({ok:true});
}));
app.get('/api/notifications', auth, asyncHandler(async (req,res)=>{
  const recipient=pushRecipient(req);
  const result=await pool.query(`SELECT id,notification_type,title,body,data,read_at,created_at FROM mesh_notifications
    WHERE recipient_type=$1 AND recipient_id=$2 ORDER BY created_at DESC LIMIT 50`,[recipient.type,recipient.id]);
  res.json({notifications:result.rows});
}));
app.patch('/api/notifications/:id/read', auth, asyncHandler(async (req,res)=>{
  const id=Number(req.params.id),recipient=pushRecipient(req);
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'رقم الإشعار غير صحيح'});
  const result=await pool.query(`UPDATE mesh_notifications SET read_at=COALESCE(read_at,NOW())
    WHERE id=$1 AND recipient_type=$2 AND recipient_id=$3 RETURNING id,read_at`,[id,recipient.type,recipient.id]);
  if(!result.rowCount)return res.status(404).json({error:'الإشعار غير موجود'});
  res.json({ok:true,notification:result.rows[0]});
}));

/* Public application settings */
app.get('/api/settings', asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT setting_key, setting_value FROM mesh_settings');
  res.json({
    settings: Object.fromEntries(result.rows.map(row => [row.setting_key, Number(row.setting_value)]))
  });
}));


/* Geographic service coverage: server-side polygons are authoritative. */
let serviceCoverageSnapshotCache = null;
async function loadServiceCoverageSnapshot(db = pool, { forceRefresh = false } = {}) {
  if (db === pool && !forceRefresh && serviceCoverageSnapshotCache && serviceCoverageSnapshotCache.expiresAt > Date.now()) {
    return serviceCoverageSnapshotCache.value;
  }
  const [areas, enforcement] = await Promise.all([
    db.query(
      `SELECT a.id, a.country_code, c.country_name, c.enabled AS country_enabled,
         a.region_name, a.enabled AS area_enabled, a.geojson
       FROM mesh_service_areas a
       JOIN mesh_service_countries c ON c.country_code = a.country_code
       ORDER BY a.id`
    ),
    db.query("SELECT setting_value FROM mesh_settings WHERE setting_key='service_coverage_enforced'")
  ]);
  const value = { areas: areas.rows, enforced: enforcement.rows[0]?.setting_value === 'true' };
  if (db === pool) serviceCoverageSnapshotCache = { value, expiresAt: Date.now() + 15000 };
  return value;
}

function resolveServiceCoverageFromSnapshot(latitude, longitude, snapshot) {
  const matches = snapshot.areas.filter(area => pointInGeoJSON(latitude, longitude, area.geojson));
  const match = matches.find(area => area.country_enabled && area.area_enabled) || matches[0];
  if (!match) return {
    enforced: snapshot.enforced, allowed: !snapshot.enforced,
    countryCode: null, countryName: null, regionName: null,
    reason: snapshot.enforced ? 'coverage_unavailable' : 'coverage_not_configured'
  };
  const allowed = Boolean(match.country_enabled && match.area_enabled);
  return {
    enforced: snapshot.enforced, allowed: snapshot.enforced ? allowed : true,
    countryCode: String(match.country_code).trim(), countryName: match.country_name,
    regionName: match.region_name,
    reason: !match.country_enabled ? 'country_disabled' : (!match.area_enabled ? 'area_disabled' : null)
  };
}

async function resolveServiceCoverage(latitude, longitude, db = pool) {
  const snapshot = await loadServiceCoverageSnapshot(db);
  return resolveServiceCoverageFromSnapshot(latitude, longitude, snapshot);
}

app.get('/api/coverage', asyncHandler(async (req, res) => {
  const latitude = Number(req.query.lat), longitude = Number(req.query.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return res.status(400).json({ error: 'إحداثيات الموقع غير صحيحة' });
  }
  const coverage = await resolveServiceCoverage(latitude, longitude);
  res.set('Cache-Control', 'private, max-age=15');
  res.json(coverage);
}));

app.get('/api/admin/service-areas', auth, role('admin'), asyncHandler(async (req, res) => {
  const countries = await pool.query(
    `SELECT c.country_code, c.country_name, c.enabled,
       COUNT(a.id)::int AS area_count,
       COUNT(a.id) FILTER (WHERE a.enabled)::int AS enabled_area_count
     FROM mesh_service_countries c LEFT JOIN mesh_service_areas a ON a.country_code=c.country_code
     GROUP BY c.country_code ORDER BY c.country_name`
  );
  const areas = await pool.query(
    `SELECT id, country_code, region_name, geojson, enabled, updated_at
     FROM mesh_service_areas ORDER BY country_code, region_name`
  );
  const setting = await pool.query(
    "SELECT setting_value FROM mesh_settings WHERE setting_key='service_coverage_enforced'"
  );
  res.json({ countries: countries.rows, areas: areas.rows,
    enforced: setting.rows[0]?.setting_value === 'true' });
}));

app.put('/api/admin/service-coverage', auth, role('admin'), asyncHandler(async (req, res) => {
  const enabled = req.body?.enforced;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'قيمة تفعيل التغطية غير صحيحة' });
  if (enabled) {
    const configured = await pool.query(
      `SELECT COUNT(*)::int AS total FROM mesh_service_areas a
       JOIN mesh_service_countries c ON c.country_code=a.country_code
       WHERE a.enabled=TRUE AND c.enabled=TRUE`
    );
    if (!configured.rows[0].total) {
      return res.status(409).json({ error: 'أضف منطقة خدمة مفعّلة ودولة مفعّلة قبل تشغيل فرض نطاق التغطية' });
    }
  }
  await pool.query(
    `INSERT INTO mesh_settings(setting_key,setting_value) VALUES('service_coverage_enforced',$1)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,
    [String(enabled)]
  );
  serviceCoverageSnapshotCache = null;
  await audit(adminActorId(req), 'service_coverage_enforcement', null, { enabled });
  res.json({ ok: true, enforced: enabled });
}));

app.post('/api/admin/service-countries', auth, role('admin'), asyncHandler(async (req, res) => {
  const code = clean(req.body?.countryCode, 2).toUpperCase();
  const name = clean(req.body?.countryName, 120);
  const enabled = req.body?.enabled;
  if (!/^[A-Z]{2}$/.test(code) || !name || typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'أدخل رمز الدولة ISO من حرفين واسم الدولة وحالة التفعيل' });
  }
  const result = await pool.query(
    `INSERT INTO mesh_service_countries(country_code,country_name,enabled)
     VALUES($1,$2,$3) ON CONFLICT(country_code) DO UPDATE
     SET country_name=EXCLUDED.country_name,enabled=EXCLUDED.enabled,updated_at=NOW()
     RETURNING country_code,country_name,enabled`, [code,name,enabled]
  );
  serviceCoverageSnapshotCache = null;
  await audit(adminActorId(req), 'service_country_updated', null, result.rows[0]);
  res.json({ ok: true, country: result.rows[0] });
}));

app.post('/api/admin/service-areas', auth, role('admin'), asyncHandler(async (req, res) => {
  const code = clean(req.body?.countryCode, 2).toUpperCase();
  const countryName = clean(req.body?.countryName, 120);
  const regionName = clean(req.body?.regionName, 160);
  const geojson = req.body?.geojson;
  if (!/^[A-Z]{2}$/.test(code) || !countryName || !regionName || !validatePolygonGeoJSON(geojson)) {
    return res.status(400).json({ error: 'بيانات الدولة أو المنطقة أو مضلع GeoJSON غير صحيحة' });
  }
  await pool.query(
    `INSERT INTO mesh_service_countries(country_code,country_name,enabled)
     VALUES($1,$2,FALSE) ON CONFLICT(country_code) DO UPDATE
     SET country_name=EXCLUDED.country_name,updated_at=NOW()`, [code,countryName]
  );
  const result = await pool.query(
    `INSERT INTO mesh_service_areas(country_code,region_name,geojson,enabled)
     VALUES($1,$2,$3::jsonb,$4) RETURNING id,country_code,region_name,geojson,enabled`,
    [code,regionName,JSON.stringify(geojson),req.body?.enabled !== false]
  );
  serviceCoverageSnapshotCache = null;
  await audit(adminActorId(req), 'service_area_created', result.rows[0].id,
    { countryCode: code, regionName, enabled: result.rows[0].enabled });
  res.status(201).json({ ok: true, area: result.rows[0] });
}));

app.patch('/api/admin/service-areas/:id', auth, role('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'معرف المنطقة غير صحيح' });
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'حالة المنطقة غير صحيحة' });
  const result = await pool.query(
    `UPDATE mesh_service_areas SET enabled=$1,updated_at=NOW()
     WHERE id=$2 RETURNING id,country_code,region_name,enabled`, [enabled,id]
  );
  serviceCoverageSnapshotCache = null;
  if (!result.rowCount) return res.status(404).json({ error: 'منطقة الخدمة غير موجودة' });
  await audit(adminActorId(req), 'service_area_status', id, { enabled });
  res.json({ ok: true, area: result.rows[0] });
}));

app.delete('/api/admin/service-areas/:id', auth, role('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'معرف المنطقة غير صحيح' });
  const result = await pool.query(
    'DELETE FROM mesh_service_areas WHERE id=$1 RETURNING id,country_code,region_name', [id]
  );
  serviceCoverageSnapshotCache = null;
  if (!result.rowCount) return res.status(404).json({ error: 'منطقة الخدمة غير موجودة' });
  await audit(adminActorId(req), 'service_area_deleted', id, result.rows[0]);
  res.json({ ok: true });
}));

/* Driver location: stored only while the driver is actively available. */
app.put('/api/driver/location', auth, role('driver'), asyncHandler(async (req, res) => {
  const lat = Number(req.body?.latitude), lng = Number(req.body?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'إحداثيات الموقع غير صحيحة' });
  }
  const result = await pool.query(
    `UPDATE mesh_driver_profiles d SET latitude=$1, longitude=$2, location_updated_at=NOW()
     FROM mesh_accounts a WHERE d.account_id=$3 AND a.id=d.account_id AND a.role='driver'
       AND a.status='active' AND a.lifecycle_state='open' AND d.is_off_duty=FALSE
     RETURNING d.location_updated_at`, [lat, lng, req.user.sub]
  );
  if (!result.rowCount) return res.status(409).json({ error: 'فعّل استقبال الرحلات أولاً حتى تتم مشاركة موقعك' });
  res.json({ ok: true, updatedAt: result.rows[0].location_updated_at });
}));

/* Passenger sees only approved, available drivers with fresh shared locations. */
app.get('/api/drivers/nearby', auth, role('passenger'), asyncHandler(async (req, res) => {
  const lat=Number(req.query.lat), lng=Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180) {
    return res.status(400).json({ error: 'حدد موقعك على الخريطة أولاً' });
  }
  // Reuse the short coverage cache for frequent map refreshes; admin changes invalidate it.
  const coverageSnapshot = await loadServiceCoverageSnapshot();
  const coverage = resolveServiceCoverageFromSnapshot(lat, lng, coverageSnapshot);
  if (coverage.enforced && !coverage.allowed) {
    return res.status(403).json({ error: 'عذراً، خدمات مشواري غير متوفرة في بلدك/منطقتك حالياً',
      code: 'SERVICE_AREA_UNAVAILABLE', coverage });
  }
  // Read candidates in bounded batches. Filtering only the first 200 would hide
  // valid drivers whenever many nearer drivers are outside enabled service polygons.
  // Keyset pagination keeps each database query bounded and preserves distance order.
  const eligibleDrivers = [];
  let cursorDistance = null;
  let cursorId = null;
  const batchSize = 200;
  while (eligibleDrivers.length < 30) {
    const result = await pool.query(
      `WITH available AS (
         SELECT a.id, a.full_name, d.car_type, d.car_model, d.car_color, d.plate_number,
           d.latitude, d.longitude,
           (6371 * acos(LEAST(1, GREATEST(-1,
             sin(radians($1))*sin(radians(d.latitude)) + cos(radians($1))*cos(radians(d.latitude))*cos(radians(d.longitude-$2))
           )))) AS distance_km
         FROM mesh_accounts a JOIN mesh_driver_profiles d ON d.account_id=a.id
         WHERE a.role='driver' AND a.status='active' AND a.lifecycle_state='open'
           AND d.is_off_duty=FALSE AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL
           AND d.location_updated_at > NOW() - INTERVAL '3 minutes'
           AND NOT EXISTS (SELECT 1 FROM mesh_trips t WHERE t.driver_id=a.id
             AND t.status IN ('requested','accepted','arrived','in_progress'))
       )
       SELECT * FROM available
       WHERE $3::double precision IS NULL OR (distance_km, id) > ($3::double precision, $4::bigint)
       ORDER BY distance_km ASC, id ASC
       LIMIT $5`,
      [lat, lng, cursorDistance, cursorId, batchSize]
    );
    if (!result.rows.length) break;

    const lastCandidate = result.rows[result.rows.length - 1];
    cursorDistance = Number(lastCandidate.distance_km);
    cursorId = lastCandidate.id;

    for (const driver of result.rows) {
      if (coverageSnapshot.enforced) {
        const driverCoverage = resolveServiceCoverageFromSnapshot(
          Number(driver.latitude), Number(driver.longitude), coverageSnapshot
        );
        if (!driverCoverage.allowed) continue;
      }
      eligibleDrivers.push({ ...driver, distance_km: Number(driver.distance_km) });
      if (eligibleDrivers.length === 30) break;
    }

    if (result.rows.length < batchSize) break;
  }
  res.json({ drivers: eligibleDrivers });
}));

/* Passenger creates a request for the selected nearby driver. */
app.post('/api/trips', auth, role('passenger'), asyncHandler(async (req, res) => {
  const destination = clean(req.body?.destination, 500);
  const pickupLat=Number(req.body?.pickupLat), pickupLng=Number(req.body?.pickupLng);
  const destinationLat=Number(req.body?.destinationLat), destinationLng=Number(req.body?.destinationLng);
  const driverId=Number(req.body?.driverId);
  const rawStops=Array.isArray(req.body?.stops)?req.body.stops:[];
  if (!destination || !Number.isFinite(pickupLat) || !Number.isFinite(pickupLng) ||
      Math.abs(pickupLat)>90 || Math.abs(pickupLng)>180 || !Number.isSafeInteger(driverId) ||
      !Number.isFinite(destinationLat) || !Number.isFinite(destinationLng) ||
      Math.abs(destinationLat)>90 || Math.abs(destinationLng)>180 || rawStops.length>5) {
    return res.status(400).json({ error: 'تحقق من موقع الانطلاق والوجهة وعدد نقاط التوقف وسيارة التاكسي' });
  }
  const stops=[];
  for(const point of rawStops){
    const label=clean(point?.label,500),lat=Number(point?.lat),lng=Number(point?.lng);
    if(!label||!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)
      return res.status(400).json({error:'بيانات إحدى نقاط التوقف غير مكتملة'});
    stops.push({label,lat,lng});
  }
  const requestedPoints = [{ latitude: pickupLat, longitude: pickupLng },
    ...stops.map(point => ({ latitude: point.lat, longitude: point.lng })),
    { latitude: destinationLat, longitude: destinationLng }];
  // A trip is a high-impact action: re-read current country/area switches instead of
  // relying on the short public coverage cache, so an admin disable takes effect here.
  const coverageSnapshot = await loadServiceCoverageSnapshot(pool, { forceRefresh: true });
  for (const point of requestedPoints) {
    const coverage = resolveServiceCoverageFromSnapshot(point.latitude, point.longitude, coverageSnapshot);
    if (coverage.enforced && !coverage.allowed) {
      return res.status(403).json({ error: 'عذراً، خدمات مشواري غير متوفرة في بلدك/منطقتك حالياً',
        code: 'SERVICE_AREA_UNAVAILABLE', coverage });
    }
  }
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize trip creation per passenger; SELECT ... FOR UPDATE cannot lock a missing row.
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [req.user.sub]);
    const passengerActive=await client.query(
      `SELECT id FROM mesh_trips WHERE passenger_id=$1 AND status IN ('requested','accepted','arrived','in_progress') LIMIT 1`,[req.user.sub]
    );
    if(passengerActive.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'لديك طلب رحلة قائم بالفعل. أنهِ الطلب الحالي أولاً.'});}
    const driver=await client.query(
      `SELECT a.id,d.latitude,d.longitude FROM mesh_accounts a
       JOIN mesh_driver_profiles d ON d.account_id=a.id
       WHERE a.id=$1 AND a.role='driver' AND a.status='active' AND a.lifecycle_state='open'
         AND d.is_off_duty=FALSE AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL
         AND d.latitude BETWEEN -90 AND 90 AND d.longitude BETWEEN -180 AND 180
         AND d.location_updated_at>NOW()-INTERVAL '3 minutes'
         AND NOT EXISTS (SELECT 1 FROM mesh_trips t WHERE t.driver_id=a.id AND t.status IN ('requested','accepted','arrived','in_progress'))
       FOR UPDATE OF d`,[driverId]
    );
    if(!driver.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'السائق لم يعد متاحاً. حدّث قائمة السيارات القريبة.'});}
    if (coverageSnapshot.enforced) {
      const driverCoverage = resolveServiceCoverageFromSnapshot(
        Number(driver.rows[0].latitude), Number(driver.rows[0].longitude), coverageSnapshot
      );
      if (!driverCoverage.allowed) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'السائق خارج نطاق الخدمة المفعّل حالياً. اختر سيارة أخرى.',
          code: 'DRIVER_OUTSIDE_SERVICE_AREA', coverage: driverCoverage });
      }
    }
    const settings=await client.query(`SELECT setting_key,setting_value FROM mesh_settings WHERE setting_key IN ('base_fare','per_km_rate')`);
    const cfg=Object.fromEntries(settings.rows.map(x=>[x.setting_key,Number(x.setting_value)]));
    const rad=x=>x*Math.PI/180, dlat=rad(driver.rows[0].latitude-pickupLat),dlng=rad(driver.rows[0].longitude-pickupLng);
    const a=Math.sin(dlat/2)**2+Math.cos(rad(pickupLat))*Math.cos(rad(driver.rows[0].latitude))*Math.sin(dlng/2)**2;
    const pickupDistance=6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
    const estimatedDistance=Math.max(1,Math.ceil(pickupDistance*10)/10+5);
    const fare=(cfg.base_fare||1000)+(cfg.per_km_rate||300)*estimatedDistance;
    const trip=await client.query(
      `INSERT INTO mesh_trips(passenger_id,driver_id,pickup_address,dropoff_address,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,stops,distance_km,fare_amount,status)
       VALUES($1,$2,'موقعي الحالي',$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'requested') RETURNING *`,
      [req.user.sub,driverId,destination,pickupLat,pickupLng,destinationLat,destinationLng,JSON.stringify(stops),estimatedDistance,fare]
    );
    await client.query('COMMIT');
    try {
      await saveAndSendNotification({type:'driver',id:String(driverId)},
        {type:'trip_request',title:'طلب تاكسي جديد',body:'لديك طلب رحلة جديد. افتح مشواري لمراجعته.',
         data:{tripId:trip.rows[0].id,screen:'trips'}});
    } catch (error) { console.error('Driver trip notification failed:', error.message); }
    res.status(201).json({ok:true,trip:trip.rows[0],estimated:true,message:'تم إرسال طلب الرحلة إلى السائق. ستبدأ المحادثة بعد قبوله.'});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));

/* Passenger's current requested or active trip. */
app.get('/api/passenger/trips', auth, role('passenger'), asyncHandler(async(req,res)=>{
  const r=await pool.query(
    `SELECT t.*,a.full_name AS driver_name,d.car_type,d.car_model,d.car_color,d.plate_number
     FROM mesh_trips t LEFT JOIN mesh_accounts a ON a.id=t.driver_id
     LEFT JOIN mesh_driver_profiles d ON d.account_id=t.driver_id
     WHERE t.passenger_id=$1 AND (t.status IN ('requested','accepted','arrived','in_progress') OR (t.status='completed' AND t.payment_status IS DISTINCT FROM 'paid'))
     ORDER BY t.created_at DESC LIMIT 1`,[req.user.sub]
  );
  res.json({trip:r.rows[0]||null});
}));

/* Passenger trip history, separate from the current active-trip endpoint. */
app.get('/api/passenger/trips/history', auth, role('passenger'), asyncHandler(async(req,res)=>{
  const result=await pool.query(
    `SELECT t.id,t.pickup_address,t.dropoff_address,t.fare_amount,t.status,t.payment_status,t.created_at,
       a.full_name AS driver_name,d.car_type,d.car_model,d.car_color
     FROM mesh_trips t LEFT JOIN mesh_accounts a ON a.id=t.driver_id
     LEFT JOIN mesh_driver_profiles d ON d.account_id=t.driver_id
     WHERE t.passenger_id=$1 ORDER BY t.created_at DESC,t.id DESC LIMIT 50`,[req.user.sub]
  );
  res.json({trips:result.rows});
}));

/* Driver's incoming and active trips. */
app.get('/api/driver/trips', auth, role('driver'), asyncHandler(async(req,res)=>{
  const r=await pool.query(
    `SELECT t.id,t.passenger_id,t.dropoff_address,t.pickup_lat,t.pickup_lng,t.dropoff_lat,t.dropoff_lng,t.stops,t.fare_amount,t.distance_km,t.status,t.created_at,a.full_name AS passenger_name
     FROM mesh_trips t JOIN mesh_accounts a ON a.id=t.passenger_id
     WHERE t.driver_id=$1 AND (t.status IN ('requested','accepted','arrived','in_progress') OR (t.status='completed' AND t.payment_status IS DISTINCT FROM 'paid')) ORDER BY t.created_at DESC LIMIT 10`,[req.user.sub]
  );
  res.json({trips:r.rows});
}));

/* Driver updates the trip lifecycle. */
app.patch('/api/trips/:id/status', auth, asyncHandler(async(req,res)=>{
  if(!['passenger','driver'].includes(req.user.role))return res.status(403).json({error:'غير مسموح'});
  const id=Number(req.params.id),status=clean(req.body?.status,30);
  if(!Number.isSafeInteger(id)||!['accepted','arrived','in_progress','completed','cancelled'].includes(status))return res.status(400).json({error:'حالة الرحلة غير صحيحة'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const trip=await client.query('SELECT * FROM mesh_trips WHERE id=$1 AND (passenger_id=$2 OR driver_id=$2) FOR UPDATE',[id,req.user.sub]);
    if(!trip.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'الرحلة غير موجودة'});}
    const t=trip.rows[0];
    const driverStatuses=['accepted','arrived','in_progress','completed'];
    if(req.user.role==='driver'&&!driverStatuses.includes(status)){await client.query('ROLLBACK');return res.status(403).json({error:'ليس لديك صلاحية لهذه الحالة'});}
    if(req.user.role==='passenger'&&status!=='cancelled'){await client.query('ROLLBACK');return res.status(403).json({error:'الراكب يستطيع إلغاء الطلب فقط'});}
    const allowed={requested:['accepted','cancelled'],accepted:['arrived','cancelled'],arrived:['in_progress','cancelled'],in_progress:['completed']};
    if(!(allowed[t.status]||[]).includes(status)){await client.query('ROLLBACK');return res.status(409).json({error:'لا يمكن تغيير حالة الرحلة من الحالة الحالية'});}
    const updated=await client.query(
      `UPDATE mesh_trips SET status=$1,updated_at=NOW(),completed_at=CASE WHEN $1 IN ('completed','cancelled') THEN NOW() ELSE completed_at END WHERE id=$2 RETURNING *`,[status,id]
    );
    // Cancellation closes the temporary chat immediately. A completed trip keeps
    // the chat available only while payment is still outstanding.
    if(status==='cancelled' || status==='completed') await client.query("UPDATE mesh_trip_calls SET status='ended',updated_at=NOW() WHERE trip_id=$1 AND status IN ('ringing','accepted')",[id]);
    if(status==='cancelled') await client.query('DELETE FROM mesh_trip_messages WHERE trip_id=$1',[id]);
    if(status==='completed' && t.payment_status==='paid') await client.query('DELETE FROM mesh_trip_messages WHERE trip_id=$1',[id]);
    await client.query('COMMIT');

    // Persist and deliver a push update to the other trip participant. Delivery
    // is deliberately outside the trip transaction so an FCM outage cannot undo
    // a valid lifecycle transition.
    const statusNotifications = {
      accepted: { title: 'تم قبول الرحلة', body: 'وافق السائق على طلب رحلتك.' },
      arrived: { title: 'وصل السائق', body: 'السائق وصل إلى موقع الانطلاق.' },
      in_progress: { title: 'بدأت الرحلة', body: 'بدأت رحلتك مع السائق.' },
      completed: { title: 'اكتملت الرحلة', body: 'تم إنهاء الرحلة. راجع تفاصيل الدفع.' },
      cancelled: { title: 'تم إلغاء الرحلة', body: 'ألغى الراكب طلب الرحلة.' }
    };
    const statusNotice = statusNotifications[status];
    const recipient = req.user.role === 'passenger'
      ? { type: 'driver', id: String(t.driver_id) }
      : { type: 'passenger', id: String(t.passenger_id) };
    try {
      await saveAndSendNotification(recipient, {
        type: 'trip_' + status,
        title: statusNotice.title,
        body: statusNotice.body,
        data: { tripId: id, status, screen: 'trips' }
      });
    } catch (error) {
      console.error('Trip status notification failed:', error.message);
    }

    res.json({ok:true,trip:updated.rows[0]});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));

/* Private audio-call signaling for trip participants. Media travels peer-to-peer;
   the API stores only short-lived SDP/ICE signaling data, never audio recordings. */
const tripCallStartLimiter = rateLimit({ windowMs: 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
async function loadTripCallParticipant(tripId, userId) {
  const result = await pool.query(
    "SELECT id,passenger_id,driver_id,status,payment_status FROM mesh_trips WHERE id=$1 AND (passenger_id=$2 OR driver_id=$2)",
    [tripId, userId]
  );
  return result.rows[0] || null;
}
function makeTripCallIceServers(userId) {
  return createTripCallIceServers({
    turnUrls: process.env.TURN_URLS,
    sharedSecret: process.env.TURN_SHARED_SECRET,
    userId
  });
}
app.get('/api/trips/:id/calls/config', auth, asyncHandler(async (req, res) => {
  const tripId = Number(req.params.id);
  if (!Number.isSafeInteger(tripId)) return res.status(400).json({ error: 'رقم الرحلة غير صحيح' });
  const trip = await loadTripCallParticipant(tripId, req.user.sub);
  if (!trip) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  if (!['accepted','arrived','in_progress'].includes(trip.status)) {
    return res.status(409).json({ error: 'الاتصال الصوتي متاح بعد قبول الرحلة وحتى انتهائها' });
  }
  res.json({ iceServers: makeTripCallIceServers(req.user.sub), turnConfigured: Boolean(process.env.TURN_URLS && process.env.TURN_SHARED_SECRET) });
}));
app.post('/api/trips/:id/calls', auth, tripCallStartLimiter, asyncHandler(async (req, res) => {
  const tripId = Number(req.params.id);
  const offer = req.body?.offer;
  if (!Number.isSafeInteger(tripId) || !offer || offer.type !== 'offer' || typeof offer.sdp !== 'string' || offer.sdp.length < 20 || offer.sdp.length > 50000) {
    return res.status(400).json({ error: 'بيانات بدء المكالمة غير صحيحة' });
  }
  const trip = await loadTripCallParticipant(tripId, req.user.sub);
  if (!trip) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  if (!['accepted','arrived','in_progress'].includes(trip.status) || !trip.driver_id) {
    return res.status(409).json({ error: 'الاتصال الصوتي متاح بعد قبول السائق للرحلة' });
  }
  const calleeId = String(trip.passenger_id) === String(req.user.sub) ? trip.driver_id : trip.passenger_id;
  await pool.query("UPDATE mesh_trip_calls SET status='expired',updated_at=NOW() WHERE trip_id=$1 AND status IN ('ringing','accepted') AND expires_at<=NOW()", [tripId]);
  try {
    const result = await pool.query(
      "INSERT INTO mesh_trip_calls(trip_id,caller_id,callee_id,status,offer_sdp) VALUES($1,$2,$3,'ringing',$4) RETURNING id,trip_id,caller_id,callee_id,status,offer_sdp,answer_sdp,created_at,expires_at",
      [tripId, req.user.sub, calleeId, offer.sdp]
    );
    res.status(201).json({ ok: true, call: result.rows[0] });
  } catch (error) {
    if (error && error.code === '23505') return res.status(409).json({ error: 'توجد مكالمة أخرى نشطة في هذه الرحلة' });
    throw error;
  }
}));
app.get('/api/trips/:id/calls/active', auth, asyncHandler(async (req, res) => {
  const tripId = Number(req.params.id);
  if (!Number.isSafeInteger(tripId)) return res.status(400).json({ error: 'رقم الرحلة غير صحيح' });
  const trip = await loadTripCallParticipant(tripId, req.user.sub);
  if (!trip) return res.status(404).json({ error: 'الرحلة غير موجودة' });
  await pool.query("UPDATE mesh_trip_calls SET status='expired',updated_at=NOW() WHERE trip_id=$1 AND status IN ('ringing','accepted') AND expires_at<=NOW()", [tripId]);
  const result = await pool.query(
    "SELECT id,trip_id,caller_id,callee_id,status,offer_sdp,answer_sdp,created_at,expires_at FROM mesh_trip_calls WHERE trip_id=$1 AND (caller_id=$2 OR callee_id=$2) AND status IN ('ringing','accepted') ORDER BY id DESC LIMIT 1",
    [tripId, req.user.sub]
  );
  res.json({ call: result.rows[0] || null });
}));
app.patch('/api/trips/:tripId/calls/:callId/answer', auth, asyncHandler(async (req, res) => {
  const tripId = Number(req.params.tripId), callId = Number(req.params.callId), answer = req.body?.answer;
  if (!Number.isSafeInteger(tripId) || !Number.isSafeInteger(callId) || !answer || answer.type !== 'answer' || typeof answer.sdp !== 'string' || answer.sdp.length < 20 || answer.sdp.length > 50000) {
    return res.status(400).json({ error: 'بيانات الرد على المكالمة غير صحيحة' });
  }
  const result = await pool.query(
    "UPDATE mesh_trip_calls c SET answer_sdp=$1,status='accepted',updated_at=NOW(),expires_at=NOW()+INTERVAL '90 seconds' FROM mesh_trips t WHERE c.id=$2 AND c.trip_id=$3 AND c.callee_id=$4 AND c.status='ringing' AND c.expires_at>NOW() AND t.id=c.trip_id AND t.status IN ('accepted','arrived','in_progress') AND (t.passenger_id=$4 OR t.driver_id=$4) RETURNING c.id,c.status",
    [answer.sdp, callId, tripId, req.user.sub]
  );
  if (!result.rowCount) return res.status(409).json({ error: 'انتهت صلاحية طلب الاتصال أو لم يعد متاحاً' });
  res.json({ ok: true, call: result.rows[0] });
}));
app.patch('/api/trips/:tripId/calls/:callId/heartbeat', auth, asyncHandler(async (req, res) => {
  const tripId = Number(req.params.tripId), callId = Number(req.params.callId);
  if (!Number.isSafeInteger(tripId) || !Number.isSafeInteger(callId)) return res.status(400).json({ error: 'بيانات المكالمة غير صحيحة' });
  const result = await pool.query(
    "UPDATE mesh_trip_calls c SET expires_at=NOW()+INTERVAL '90 seconds',updated_at=NOW() FROM mesh_trips t WHERE c.id=$1 AND c.trip_id=$2 AND c.status='accepted' AND t.id=c.trip_id AND t.status IN ('accepted','arrived','in_progress') AND (c.caller_id=$3 OR c.callee_id=$3) RETURNING c.id,c.expires_at",
    [callId, tripId, req.user.sub]
  );
  if (!result.rowCount) return res.status(409).json({ error: 'انتهت المكالمة أو لم تعد الرحلة نشطة' });
  res.json({ ok: true, expires_at: result.rows[0].expires_at });
}));
app.post('/api/trips/:tripId/calls/:callId/ice', auth, asyncHandler(async (req, res) => {
  const tripId = Number(req.params.tripId), callId = Number(req.params.callId), candidate = req.body?.candidate;
  if (!Number.isSafeInteger(tripId) || !Number.isSafeInteger(callId) || !candidate || typeof candidate !== 'object' || JSON.stringify(candidate).length > 5000 || typeof candidate.candidate !== 'string') {
    return res.status(400).json({ error: 'بيانات الاتصال الشبكي غير صحيحة' });
  }
  const allowed = await pool.query(
    "SELECT c.id FROM mesh_trip_calls c JOIN mesh_trips t ON t.id=c.trip_id WHERE c.id=$1 AND c.trip_id=$2 AND c.status IN ('ringing','accepted') AND c.expires_at>NOW() AND (c.caller_id=$3 OR c.callee_id=$3) AND t.status IN ('accepted','arrived','in_progress')",
    [callId, tripId, req.user.sub]
  );
  if (!allowed.rowCount) return res.status(409).json({ error: 'المكالمة غير نشطة' });
  const count = await pool.query('SELECT COUNT(*)::int AS total FROM mesh_trip_call_ice WHERE call_id=$1 AND sender_id=$2', [callId, req.user.sub]);
  if (count.rows[0].total >= 200) return res.status(429).json({ error: 'تم بلوغ حد بيانات الاتصال لهذه المكالمة' });
  await pool.query('INSERT INTO mesh_trip_call_ice(call_id,sender_id,candidate) VALUES($1,$2,$3::jsonb)', [callId, req.user.sub, JSON.stringify(candidate)]);
  res.status(201).json({ ok: true });
}));
app.get('/api/trips/:tripId/calls/:callId/ice', auth, asyncHandler(async (req, res) => {
  const tripId = Number(req.params.tripId), callId = Number(req.params.callId), after = Math.max(0, Number(req.query.after) || 0);
  if (!Number.isSafeInteger(tripId) || !Number.isSafeInteger(callId) || !Number.isSafeInteger(after)) return res.status(400).json({ error: 'بيانات الاتصال الشبكي غير صحيحة' });
  const allowed = await pool.query(
    "SELECT c.id FROM mesh_trip_calls c JOIN mesh_trips t ON t.id=c.trip_id WHERE c.id=$1 AND c.trip_id=$2 AND c.status IN ('ringing','accepted') AND c.expires_at>NOW() AND t.status IN ('accepted','arrived','in_progress') AND (c.caller_id=$3 OR c.callee_id=$3)",
    [callId, tripId, req.user.sub]
  );
  if (!allowed.rowCount) return res.status(404).json({ error: 'المكالمة غير موجودة' });
  const result = await pool.query(
    "SELECT i.id,i.candidate FROM mesh_trip_call_ice i WHERE i.call_id=$1 AND i.sender_id<>$2 AND i.id>$3 ORDER BY i.id ASC LIMIT 100",
    [callId, req.user.sub, after]
  );
  res.json({ candidates: result.rows });
}));
app.patch('/api/trips/:tripId/calls/:callId/end', auth, asyncHandler(async (req, res) => {
  const tripId = Number(req.params.tripId), callId = Number(req.params.callId);
  if (!Number.isSafeInteger(tripId) || !Number.isSafeInteger(callId)) return res.status(400).json({ error: 'بيانات المكالمة غير صحيحة' });
  const result = await pool.query(
    "UPDATE mesh_trip_calls SET status=CASE WHEN status='ringing' AND callee_id=$3 THEN 'rejected' ELSE 'ended' END,updated_at=NOW() WHERE id=$1 AND trip_id=$2 AND (caller_id=$3 OR callee_id=$3) AND status IN ('ringing','accepted') RETURNING id,status",
    [callId, tripId, req.user.sub]
  );
  if (!result.rowCount) return res.json({ ok: true, alreadyEnded: true });
  res.json({ ok: true, call: result.rows[0] });
}));

/* Temporary trip chat: it remains available through the trip and, if needed,
   while an unpaid completed trip is being settled. It is deleted immediately
   when the trip is cancelled or when a completed trip is marked paid. */
app.get('/api/trips/:id/messages',auth,asyncHandler(async(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id))return res.status(400).json({error:'رقم الرحلة غير صحيح'});
  const trip=await pool.query(
    `SELECT id,status,payment_status FROM mesh_trips
     WHERE id=$1 AND (passenger_id=$2 OR driver_id=$2)`,[id,req.user.sub]
  );
  if(!trip.rowCount)return res.status(404).json({error:'المحادثة غير موجودة'});
  const t=trip.rows[0];
  const locked=t.status==='cancelled' || (t.status==='completed' && t.payment_status==='paid');
  if(locked){
    await pool.query('DELETE FROM mesh_trip_messages WHERE trip_id=$1',[id]);
    return res.json({messages:[],locked:true,status:t.status,payment_status:t.payment_status});
  }
  await pool.query('DELETE FROM mesh_trip_messages WHERE trip_id=$1 AND expires_at<=NOW()',[id]);
  const r=await pool.query(
    `SELECT m.id,m.sender_id,m.message,m.created_at,a.full_name AS sender_name
     FROM mesh_trip_messages m JOIN mesh_accounts a ON a.id=m.sender_id
     WHERE m.trip_id=$1 AND m.expires_at>NOW() ORDER BY m.created_at ASC LIMIT 200`,[id]
  );
  res.json({messages:r.rows,locked:false,status:t.status,payment_status:t.payment_status});
}));
app.post('/api/trips/:id/messages',auth,asyncHandler(async(req,res)=>{
  const id=Number(req.params.id),message=clean(req.body?.message,1000);
  if(!Number.isSafeInteger(id)||!message)return res.status(400).json({error:'اكتب رسالة صحيحة'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const trip=await client.query(
      `SELECT id,status,payment_status FROM mesh_trips
       WHERE id=$1 AND (passenger_id=$2 OR driver_id=$2) FOR UPDATE`,[id,req.user.sub]
    );
    if(!trip.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'المحادثة غير موجودة'});}
    const t=trip.rows[0];
    const chatOpen=['accepted','arrived','in_progress'].includes(t.status) || (t.status==='completed' && t.payment_status!=='paid');
    if(!chatOpen){await client.query('ROLLBACK');return res.status(409).json({error:'انتهت المحادثة بعد إتمام الرحلة وتسوية الدفع أو إلغاء الرحلة'});}
    const count=await client.query(`SELECT COUNT(*) FROM mesh_trip_messages WHERE trip_id=$1 AND sender_id=$2 AND created_at>NOW()-INTERVAL '1 minute'`,[id,req.user.sub]);
    if(Number(count.rows[0].count)>=12){await client.query('ROLLBACK');return res.status(429).json({error:'أرسلت رسائل كثيرة. انتظر قليلاً.'});}
    const r=await client.query(`INSERT INTO mesh_trip_messages(trip_id,sender_id,message) VALUES($1,$2,$3) RETURNING id,sender_id,message,created_at`,[id,req.user.sub,message]);
    await client.query('COMMIT');
    res.status(201).json({ok:true,message:r.rows[0]});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));

/* Admin confirms that the fare has actually been collected (this does not process a payment). */
app.patch('/api/admin/trips/:id/payment',auth,role('admin'),asyncHandler(async(req,res)=>{
  const id=Number(req.params.id);
  const paymentStatus=clean(req.body?.paymentStatus,20);
  if(!Number.isSafeInteger(id)||!['paid','unpaid'].includes(paymentStatus))
    return res.status(400).json({error:'حالة الدفع غير صحيحة'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const trip=await client.query('SELECT id,status,payment_status FROM mesh_trips WHERE id=$1 FOR UPDATE',[id]);
    if(!trip.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'الرحلة غير موجودة'});}
    if(trip.rows[0].status!=='completed' && paymentStatus==='paid'){
      await client.query('ROLLBACK');
      return res.status(409).json({error:'لا يمكن تأكيد الدفع قبل إكمال الرحلة'});
    }
    if(trip.rows[0].payment_status==='paid' && paymentStatus==='unpaid'){
      await client.query('ROLLBACK');
      return res.status(409).json({error:'تم إقفال الدفع لهذه الرحلة ولا يمكن إعادة فتح المحادثة'});
    }
    const updated=await client.query('UPDATE mesh_trips SET payment_status=$1,updated_at=NOW() WHERE id=$2 RETURNING id,status,payment_status',[paymentStatus,id]);
    if(paymentStatus==='paid' && trip.rows[0].status==='completed') {
      await client.query('DELETE FROM mesh_trip_messages WHERE trip_id=$1',[id]);
      await client.query("UPDATE mesh_trip_calls SET status='ended',updated_at=NOW() WHERE trip_id=$1 AND status IN ('ringing','accepted')",[id]);
    }
    await client.query(
      `INSERT INTO mesh_audit_logs(actor_id,action,target_id,details)
       VALUES($1,'trip_payment_status',$2,$3::jsonb)`,
      [req.user.sub,id,JSON.stringify({paymentStatus})]
    );
    await client.query('COMMIT');
    res.json({ok:true,trip:updated.rows[0],chatLocked:paymentStatus==='paid' && trip.rows[0].status==='completed'});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));


/* Driver wallet ledger: read-only for the driver; all money changes are audited. */
app.get('/api/driver/wallet', auth, role('driver'), asyncHandler(async(req,res)=>{
  const [balance,history]=await Promise.all([
    pool.query('SELECT wallet_balance,withdrawable_balance FROM mesh_driver_profiles WHERE account_id=$1',[req.user.sub]),
    pool.query(`SELECT id,amount,balance_after,transaction_type,description,created_at
      FROM mesh_driver_wallet_transactions WHERE driver_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,[req.user.sub])
  ]);
  if(!balance.rowCount)return res.status(404).json({error:'محفظة السائق غير موجودة'});
  res.json({wallet:balance.rows[0],transactions:history.rows});
}));
app.post('/api/admin/drivers/:id/wallet-adjustment', auth, role('admin'), adminRecoveryLimiter, asyncHandler(async(req,res)=>{
  const driverId=Number(req.params.id),amount=Number(req.body?.amount),description=clean(req.body?.description,500);
  if(!Number.isSafeInteger(driverId)||driverId<1||!Number.isFinite(amount)||amount===0||Math.abs(amount)>100000000||!description)
    return res.status(400).json({error:'أدخل مبلغ التسوية وسببها بشكل صحيح'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const updated=await client.query(`UPDATE mesh_driver_profiles d SET wallet_balance=d.wallet_balance+$1
      FROM mesh_accounts a WHERE d.account_id=$2 AND a.id=d.account_id AND a.role='driver'
      AND a.status='active' AND a.lifecycle_state='open'
      RETURNING d.wallet_balance,d.withdrawable_balance`,[amount,driverId]);
    if(!updated.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'السائق غير موجود أو غير نشط'});}
    const entry=await client.query(`INSERT INTO mesh_driver_wallet_transactions
      (driver_id,amount,balance_after,transaction_type,description,created_by)
      VALUES($1,$2,$3,'admin_adjustment',$4,$5) RETURNING id,amount,balance_after,transaction_type,description,created_at`,
      [driverId,amount,updated.rows[0].wallet_balance,description,req.user.sub]);
    await client.query('COMMIT');
    await audit(adminActorId(req),'driver_wallet_adjustment',driverId,{amount,description,transactionId:entry.rows[0].id});
    res.json({ok:true,wallet:updated.rows[0],transaction:entry.rows[0]});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));

/* Driver submits a replacement vehicle. The currently approved vehicle remains in history. */
app.post('/api/driver/vehicles', auth, role('driver'), asyncHandler(async (req, res) => {
  const car = req.body?.car || req.body || {};
  const fields = {
    car_type: clean(car.type ?? car.car_type, 100),
    car_model: clean(car.model ?? car.car_model, 100),
    car_color: clean(car.color ?? car.car_color, 60),
    plate_number: clean(car.plateNumber ?? car.plate_number, 50),
    registration_number: clean(car.registrationNumber ?? car.registration_number, 80),
    vehicle_image_url: clean(car.vehicleImageUrl ?? car.vehicle_image_url, 1500)
  };
  const registrationPolicy = await getApprovalPolicies();
  if (!fields.car_type || !fields.car_model || !fields.car_color || !fields.plate_number ||
      (registrationPolicy.driverRegistrationNumberRequired && !fields.registration_number)) {
    return res.status(400).json({ error: registrationPolicy.driverRegistrationNumberRequired
      ? 'أكمل جميع بيانات السيارة ورقم الملكية' : 'أكمل بيانات السيارة الأساسية' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = await client.query(
      `SELECT id FROM mesh_accounts WHERE id = $1 AND role = 'driver'
       AND status = 'active' AND lifecycle_state = 'open' FOR UPDATE`, [req.user.sub]
    );
    if (!owner.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'الحساب غير نشط أو غير معتمد' });
    }
    const pending = await client.query(
      `SELECT id FROM mesh_driver_vehicles WHERE driver_id = $1 AND status = 'pending' LIMIT 1 FOR UPDATE`,
      [req.user.sub]
    );
    if (pending.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'لديك طلب تغيير سيارة قيد مراجعة الإدارة بالفعل' });
    }
    const created = await client.query(
      `INSERT INTO mesh_driver_vehicles
       (driver_id, car_type, car_model, car_color, plate_number, registration_number, vehicle_image_url, status, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',FALSE) RETURNING id, status, submitted_at`,
      [req.user.sub, fields.car_type, fields.car_model, fields.car_color, fields.plate_number,
       fields.registration_number, fields.vehicle_image_url || null]
    );
    await client.query(
      `INSERT INTO mesh_audit_logs(actor_id, action, target_id, details)
       VALUES ($1, 'driver_vehicle_change_requested', $1, $2::jsonb)`,
      [req.user.sub, JSON.stringify({ vehicleRequestId: created.rows[0].id })]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, vehicle: created.rows[0], message: 'تم إرسال طلب تغيير السيارة. انتظر اعتماد الإدارة.' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

/* Driver may view vehicle history without exposing other drivers. */
app.get('/api/driver/vehicles', auth, role('driver'), asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT id, car_type, car_model, car_color, plate_number, registration_number,
      status, is_current, submitted_at, reviewed_at, review_reason
     FROM mesh_driver_vehicles WHERE driver_id = $1 ORDER BY submitted_at DESC`, [req.user.sub]
  );
  res.json({ vehicles: result.rows });
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
      `UPDATE mesh_driver_profiles SET is_off_duty = $1, latitude = CASE WHEN $1 THEN NULL ELSE latitude END, longitude = CASE WHEN $1 THEN NULL ELSE longitude END, location_updated_at = CASE WHEN $1 THEN NULL ELSE location_updated_at END WHERE account_id = $2 RETURNING is_off_duty`,
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
  const result = await pool.query('SELECT lock_method FROM mesh_admin_auth WHERE id = 1');
  res.json({ setupRequired: !result.rowCount, lockMethod: result.rows[0]?.lock_method || 'password' });
}));
app.post('/api/admin/pattern-challenge', adminLoginLimiter, asyncHandler(async (req, res) => {
  const username = clean(req.body?.username, 100);
  const result = await pool.query('SELECT username, lock_method FROM mesh_admin_auth WHERE id = 1');
  if (!result.rowCount || result.rows[0].lock_method !== 'pattern' || username !== result.rows[0].username) return res.status(401).json({ error: 'اسم المستخدم غير صحيح' });
  res.json({ ok: true, challenge: jwt.sign({ sub: 'admin', role: 'admin_unlock', jti: crypto.randomUUID() }, process.env.JWT_SECRET, { expiresIn: '3m' }) });
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
    await audit(1, 'admin_initial_setup', null, { username });
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
  const ownerResult = await pool.query(
    `SELECT username, password_hash, token_version, lock_method, lock_secret_hash
     FROM mesh_admin_auth WHERE id = 1`
  );
  if (ownerResult.rowCount && username === ownerResult.rows[0].username) {
    const admin = ownerResult.rows[0];
    if (admin.lock_method === 'pattern') {
      return res.json({ ok: true, lockRequired: true, lockMethod: 'pattern',
        challenge: jwt.sign({ sub: 'admin', role: 'admin_unlock', jti: crypto.randomUUID() }, process.env.JWT_SECRET, { expiresIn: '3m' }) });
    }
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    return res.json({ ok: true, token: signToken('admin', 'admin', admin.token_version), isOwner: true });
  }
  const delegated = await pool.query(
    `SELECT id, username, password_hash, permissions, token_version
     FROM mesh_admin_users WHERE username = $1 AND is_active = TRUE`, [username]
  );
  if (!delegated.rowCount || !await bcrypt.compare(password, delegated.rows[0].password_hash)) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }
  const manager = delegated.rows[0];
  return res.json({ ok: true, token: signToken(`admin:${manager.id}`, 'admin', manager.token_version),
    isOwner: false, permissions: manager.permissions || [] });
}));

/* Complete the administrator pattern unlock; challenge is short-lived and single-purpose. */
app.post('/api/admin/unlock', adminLoginLimiter, asyncHandler(async (req, res) => {
  let challenge;
  try { challenge = jwt.verify(String(req.body?.challenge || ''), process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'انتهت مهلة التحقق. أعد المحاولة' }); }
  if (challenge.role !== 'admin_unlock' || challenge.sub !== 'admin' || !challenge.jti || usedAdminUnlockChallenges.has(challenge.jti)) return res.status(401).json({ error: 'طلب تحقق غير صالح' });
  for (const [id, expiry] of usedAdminUnlockChallenges) if (expiry < Math.floor(Date.now() / 1000)) usedAdminUnlockChallenges.delete(id);
  usedAdminUnlockChallenges.set(challenge.jti, Number(challenge.exp || 0));
  const pattern = String(req.body?.pattern || '');
  if (!/^[1-9]{4,9}$/.test(pattern) || new Set(pattern).size < 4) return res.status(400).json({ error: 'النمط يجب أن يمر بأربع نقاط مختلفة على الأقل' });
  const result = await pool.query('SELECT lock_secret_hash, token_version, lock_method FROM mesh_admin_auth WHERE id = 1');
  if (!result.rowCount || result.rows[0].lock_method !== 'pattern' || !result.rows[0].lock_secret_hash || !await bcrypt.compare(pattern, result.rows[0].lock_secret_hash)) {
    return res.status(401).json({ error: 'النمط غير صحيح' });
  }
  res.json({ ok: true, token: signToken('admin', 'admin', result.rows[0].token_version) });
}));

app.put('/api/admin/lock', auth, role('admin'), adminRecoveryLimiter, asyncHandler(async (req, res) => {
  const method = String(req.body?.method || '');
  const currentPassword = String(req.body?.currentPassword || '');
  const pattern = String(req.body?.pattern || '');
  if (!['password', 'pattern'].includes(method)) return res.status(400).json({ error: 'طريقة القفل غير مدعومة حالياً' });
  if (method === 'pattern' && (!/^[1-9]{4,9}$/.test(pattern) || new Set(pattern).size < 4)) return res.status(400).json({ error: 'النمط يجب أن يمر بأربع نقاط مختلفة على الأقل' });
  const current = await pool.query('SELECT password_hash FROM mesh_admin_auth WHERE id = 1');
  if (!current.rowCount || !await bcrypt.compare(currentPassword, current.rows[0].password_hash)) return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  const hash = method === 'pattern' ? await bcrypt.hash(pattern, 12) : null;
  const updated = await pool.query(`UPDATE mesh_admin_auth SET lock_method=$1, lock_secret_hash=$2, token_version=token_version+1, updated_at=NOW() WHERE id=1 RETURNING token_version`, [method, hash]);
  await audit(adminActorId(req), 'admin_lock_method_changed', null, { method });
  res.json({ ok: true, method, token: signToken('admin', 'admin', updated.rows[0].token_version) });
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
    await audit(adminActorId(req), 'admin_password_changed', null);
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
    await audit(adminActorId(req), 'admin_recovery_code_rotated', null);
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
    await audit(1, 'admin_recovery_code_bootstrapped', null);
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
    await audit(1, 'admin_password_recovered', null);
    res.json({ ok: true, message: 'تمت استعادة كلمة المرور. يمكنك تسجيل الدخول الآن.' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

/* Multi-admin identity and delegated permissions. The legacy owner record remains untouched. */
app.get('/api/admin/me', auth, role('admin'), asyncHandler(async (req, res) => {
  res.json({ ok: true, isOwner: !!req.user.isOwner, username: req.user.username || null,
    permissions: req.user.permissions || [] });
}));

app.get('/api/admin/managers', auth, role('admin'), asyncHandler(async (req, res) => {
  if (!req.user.isOwner) return res.status(403).json({ error: 'هذه العملية للمدير الرئيسي فقط' });
  const result = await pool.query(
    `SELECT id, username, permissions, is_active, created_at, updated_at
     FROM mesh_admin_users ORDER BY created_at DESC`
  );
  res.json({ managers: result.rows });
}));

app.post('/api/admin/managers', auth, role('admin'), adminRecoveryLimiter, asyncHandler(async (req, res) => {
  if (!req.user.isOwner) return res.status(403).json({ error: 'هذه العملية للمدير الرئيسي فقط' });
  const username = clean(req.body?.username, 100);
  const password = String(req.body?.password || '');
  const allowed = new Set(['manage_whatsapp_settings', 'issue_otp']);
  const permissions = Array.isArray(req.body?.permissions) ? [...new Set(req.body.permissions)] : [];
  if (username.length < 3 || !validAdminPassword(password) || permissions.some(x => !allowed.has(x))) {
    return res.status(400).json({ error: 'تحقق من اسم المستخدم وكلمة المرور والصلاحيات المحددة' });
  }
  const ownerName = await pool.query('SELECT username FROM mesh_admin_auth WHERE id=1');
  if (ownerName.rowCount && ownerName.rows[0].username.toLowerCase() === username.toLowerCase()) {
    return res.status(409).json({ error: 'اسم المستخدم مستخدم لحساب المدير الرئيسي' });
  }
  const hash = await bcrypt.hash(password, 12);
  try {
    const result = await pool.query(
      `INSERT INTO mesh_admin_users(username, password_hash, permissions, created_by)
       VALUES ($1,$2,$3,1)
       RETURNING id, username, permissions, is_active, created_at`,
      [username, hash, permissions]
    );
    await audit(adminActorId(req), 'admin_manager_created', result.rows[0].id, { username, permissions });
    res.status(201).json({ ok: true, manager: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'اسم المدير مستخدم مسبقاً' });
    throw error;
  }
}));

app.patch('/api/admin/managers/:id', auth, role('admin'), adminRecoveryLimiter, asyncHandler(async (req, res) => {
  if (!req.user.isOwner) return res.status(403).json({ error: 'هذه العملية للمدير الرئيسي فقط' });
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'معرف المدير غير صحيح' });
  const allowed = new Set(['manage_whatsapp_settings', 'issue_otp']);
  const permissions = Array.isArray(req.body?.permissions) ? [...new Set(req.body.permissions)] : null;
  const isActive = typeof req.body?.isActive === 'boolean' ? req.body.isActive : null;
  const password = typeof req.body?.password === 'string' ? req.body.password : null;
  if (permissions && permissions.some(x => !allowed.has(x))) return res.status(400).json({ error: 'صلاحية غير معروفة' });
  if (password !== null && !validAdminPassword(password)) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 12 حرفاً على الأقل' });
  const current = await pool.query('SELECT id FROM mesh_admin_users WHERE id=$1', [id]);
  if (!current.rowCount) return res.status(404).json({ error: 'المدير غير موجود' });
  const hash = password ? await bcrypt.hash(password, 12) : null;
  const result = await pool.query(
    `UPDATE mesh_admin_users SET
       permissions = COALESCE($1::text[], permissions),
       is_active = COALESCE($2::boolean, is_active),
       password_hash = COALESCE($3::text, password_hash),
       token_version = CASE WHEN $1::text[] IS NOT NULL OR $2::boolean = FALSE OR $3::text IS NOT NULL THEN token_version + 1 ELSE token_version END,
       updated_at = NOW()
     WHERE id=$4
     RETURNING id, username, permissions, is_active, updated_at`,
    [permissions, isActive, hash, id]
  );
  await audit(adminActorId(req), 'admin_manager_updated', id, { permissions, isActive, passwordChanged: !!password });
  res.json({ ok: true, manager: result.rows[0] });
}));

const getWhatsAppConfig = async () => {
  const result = await pool.query(
    `SELECT setting_key, setting_value FROM mesh_settings
     WHERE setting_key IN ('whatsapp_otp_enabled','whatsapp_otp_template','whatsapp_otp_language')`
  );
  const values = Object.fromEntries(result.rows.map(x => [x.setting_key, x.setting_value]));
  const envReady = !!(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_API_VERSION && /^v\d+\.\d+$/.test(process.env.WHATSAPP_API_VERSION));
  const masterSwitchAllows = String(process.env.WHATSAPP_ENABLED || 'false').toLowerCase() === 'true';
  return { enabled: values.whatsapp_otp_enabled === 'true' && masterSwitchAllows, template: values.whatsapp_otp_template || '',
    language: values.whatsapp_otp_language || 'ar', configured: envReady && !!values.whatsapp_otp_template };
};

app.get('/api/admin/whatsapp/settings', auth, role('admin'), asyncHandler(async (req, res) => {
  const config = await getWhatsAppConfig();
  res.json({ ...config, secretsConfigured: !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) });
}));

app.put('/api/admin/whatsapp/settings', auth, role('admin'), asyncHandler(async (req, res) => {
  const enabled = req.body?.enabled === true;
  const template = clean(req.body?.template, 100);
  const language = clean(req.body?.language || 'ar', 20);
  if (!/^[a-zA-Z0-9_]+$/.test(template) && template !== '') return res.status(400).json({ error: 'اسم قالب واتساب غير صالح' });
  if (enabled && (String(process.env.WHATSAPP_ENABLED || 'false').toLowerCase() !== 'true' || !template ||
      !process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.WHATSAPP_ACCESS_TOKEN ||
      !/^v\d+\.\d+$/.test(process.env.WHATSAPP_API_VERSION || ''))) {
    return res.status(400).json({ error: 'لا يمكن تشغيل الإرسال قبل ضبط متغيرات WhatsApp Business والقالب المعتمد في Render' });
  }
  await pool.query(`INSERT INTO mesh_settings(setting_key,setting_value) VALUES
    ('whatsapp_otp_enabled',$1),('whatsapp_otp_template',$2),('whatsapp_otp_language',$3)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`,
    [String(enabled), template, language]);
  await audit(adminActorId(req), 'whatsapp_otp_settings_updated', null, { enabled, template, language });
  res.json({ ok: true, ...(await getWhatsAppConfig()) });
}));

async function sendWhatsAppOtp(phone, code) {
  const config = await getWhatsAppConfig();
  if (!config.enabled) return { status: 'manual', reason: 'disabled' };
  if (!config.configured) return { status: 'failed', reason: 'not_configured' };
  const recipient = String(phone || '').replace(/[\s()-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(recipient)) return { status: 'failed', reason: 'invalid_phone' };
  const url = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient,
      type: 'template', template: { name: config.template, language: { code: config.language },
        components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }] } })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('WhatsApp OTP delivery failed:', response.status, payload?.error?.code || 'provider_error');
    return { status: 'failed', reason: 'provider_rejected' };
  }
  return { status: 'sent', messageId: payload?.messages?.[0]?.id || null };
}

app.get('/api/admin/otp-eligible-accounts', auth, role('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(`SELECT id, full_name, phone, role FROM mesh_accounts
    WHERE status='active' AND lifecycle_state='open' ORDER BY full_name LIMIT 500`);
  res.json({ accounts: result.rows });
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
  const driverRegistrationNumberRequired = req.body?.driverRegistrationNumberRequired;
  if (!['manual', 'automatic'].includes(passenger) || !['manual', 'automatic'].includes(driver) ||
      typeof driverRegistrationNumberRequired !== 'boolean') {
    return res.status(400).json({ error: 'اختر سياسة صحيحة، وحدد هل رقم الملكية مطلوب أم اختياري' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO mesh_settings(setting_key, setting_value, updated_at)
       VALUES ('passenger_approval_mode',$1,NOW()), ('driver_approval_mode',$2,NOW()),
              ('driver_registration_number_required',$3,NOW())
       ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
      [passenger, driver, String(driverRegistrationNumberRequired)]
    );
    await client.query('COMMIT');
    await audit(adminActorId(req), 'approval_policies_updated', null, { passenger, driver, driverRegistrationNumberRequired });
    res.json({
      ok: true, policies: { passenger, driver, driverRegistrationNumberRequired }, automaticVerificationReady: false,
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
      (SELECT COUNT(*) FROM mesh_accounts WHERE role = 'passenger' AND deleted_at IS NULL) passengers,
      (SELECT COUNT(*) FROM mesh_accounts WHERE role = 'driver' AND deleted_at IS NULL) drivers,
      (SELECT COUNT(*) FROM mesh_accounts WHERE role = 'driver' AND status = 'active' AND lifecycle_state = 'open' AND deleted_at IS NULL) active_drivers,
      (SELECT COUNT(*) FROM mesh_accounts WHERE status = 'pending' AND lifecycle_state = 'open' AND deleted_at IS NULL) pending_accounts,
      (SELECT COUNT(*) FROM mesh_accounts WHERE lifecycle_state = 'open' AND status = 'active' AND last_activity_at < NOW() - INTERVAL '6 months' AND deleted_at IS NULL) inactive_accounts,
      (SELECT COUNT(*) FROM mesh_accounts WHERE lifecycle_state = 'suspended' AND deleted_at IS NULL) suspended_accounts,
      (SELECT COUNT(*) FROM mesh_accounts WHERE lifecycle_state = 'closed' AND deleted_at IS NULL) closed_accounts,
      (SELECT COUNT(*) FROM mesh_trips) trips,
      (SELECT COUNT(*) FROM mesh_driver_vehicles WHERE status = 'pending') pending_vehicles
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
      d.registration_number, d.wallet_balance, d.withdrawable_balance
    FROM mesh_accounts a
    LEFT JOIN mesh_driver_profiles d ON d.account_id = a.id
    WHERE a.deleted_at IS NULL
    ORDER BY a.created_at DESC
  `);
  res.json({ accounts: result.rows });
}));

/* Administration: review replacement vehicles. */
app.get('/api/admin/vehicles/pending', auth, role('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT v.*, a.full_name AS driver_name, a.phone AS driver_phone, a.status AS account_status,
      a.lifecycle_state
     FROM mesh_driver_vehicles v JOIN mesh_accounts a ON a.id = v.driver_id
     WHERE v.status = 'pending' AND a.lifecycle_state = 'open'
     ORDER BY v.submitted_at ASC LIMIT 200`
  );
  res.json({ vehicles: result.rows });
}));

app.patch('/api/admin/vehicles/:id/decision', auth, role('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const decision = clean(req.body?.decision, 20);
  const reason = clean(req.body?.reason, 500);
  if (!Number.isSafeInteger(id) || id < 1 || !['approve','reject'].includes(decision)) {
    return res.status(400).json({ error: 'بيانات القرار غير صحيحة' });
  }
  if (decision === 'reject' && reason.length < 3) {
    return res.status(400).json({ error: 'اكتب سبب رفض السيارة' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT v.*, a.status AS account_status, a.lifecycle_state
       FROM mesh_driver_vehicles v JOIN mesh_accounts a ON a.id = v.driver_id
       WHERE v.id = $1 FOR UPDATE OF v, a`, [id]
    );
    if (!found.rowCount || found.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'طلب السيارة غير موجود أو تمت مراجعته' });
    }
    const v = found.rows[0];
    if (v.lifecycle_state !== 'open' || v.account_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'حساب السائق غير نشط أو غير معتمد' });
    }
    if (decision === 'approve') {
      await client.query(
        `UPDATE mesh_driver_vehicles SET is_current = FALSE, status = 'replaced'
         WHERE driver_id = $1 AND is_current = TRUE`, [v.driver_id]
      );
      await client.query(
        `UPDATE mesh_driver_vehicles SET status = 'approved', is_current = TRUE,
           reviewed_at = NOW(), review_reason = NULL WHERE id = $1`, [id]
      );
      await client.query(
        `UPDATE mesh_driver_profiles SET car_type=$1, car_model=$2, car_color=$3,
           plate_number=$4, registration_number=$5, vehicle_image_url=$6, is_off_duty=TRUE
         WHERE account_id=$7`,
        [v.car_type, v.car_model, v.car_color, v.plate_number, v.registration_number,
         v.vehicle_image_url, v.driver_id]
      );
    } else {
      await client.query(
        `UPDATE mesh_driver_vehicles SET status = 'rejected', is_current = FALSE,
           reviewed_at = NOW(), review_reason = $2 WHERE id = $1`, [id, reason]
      );
    }
    await client.query(
      `INSERT INTO mesh_audit_logs(actor_id, action, target_id, details)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [adminActorId(req), decision === 'approve' ? 'driver_vehicle_approved' : 'driver_vehicle_rejected',
       v.driver_id, JSON.stringify({ vehicleRequestId: id, reason: decision === 'reject' ? reason : null })]
    );
    await client.query('COMMIT');
    res.json({ ok: true, message: decision === 'approve' ? 'تم اعتماد السيارة الجديدة' : 'تم رفض طلب السيارة' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

/* Reversible account trash. Linked trips and financial records remain untouched. */
app.get('/api/admin/accounts/trash', auth, role('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(`SELECT id, full_name, phone, role, status, lifecycle_state, deleted_at, deleted_reason, created_at FROM mesh_accounts WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`);
  res.json({ accounts: result.rows });
}));
app.post('/api/admin/accounts/:id/trash', auth, role('admin'), asyncHandler(async (req, res) => {
  const id=Number(req.params.id), reason=clean(req.body?.reason,1000), confirmation=clean(req.body?.confirmation,40);
  if(!Number.isSafeInteger(id)||id<1||reason.length<3||confirmation!=='MOVE_TO_TRASH') return res.status(400).json({error:'أدخل سبباً واضحاً واكتب MOVE_TO_TRASH للتأكيد'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const found=await client.query('SELECT id,role,deleted_at FROM mesh_accounts WHERE id=$1 FOR UPDATE',[id]);
    if(!found.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'الحساب غير موجود'});}
    if(found.rows[0].deleted_at){await client.query('ROLLBACK');return res.status(409).json({error:'الحساب موجود بالفعل في المحذوفات'});}
    await client.query('UPDATE mesh_accounts SET deleted_at=NOW(),deleted_reason=$2,updated_at=NOW() WHERE id=$1',[id,reason]);
    await client.query(`INSERT INTO mesh_audit_logs(actor_id,action,target_id,details) VALUES($1,'account_moved_to_trash',$2,$3::jsonb)`,[adminActorId(req),id,JSON.stringify({role:found.rows[0].role,reason})]);
    await client.query('COMMIT');res.json({ok:true,message:'تم نقل الحساب إلى المحذوفات ويمكن استعادته.'});
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}));
app.post('/api/admin/accounts/:id/restore', auth, role('admin'), asyncHandler(async (req, res) => {
  const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'معرف الحساب غير صحيح'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const found=await client.query('SELECT id,role,deleted_at FROM mesh_accounts WHERE id=$1 FOR UPDATE',[id]);
    if(!found.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'الحساب غير موجود'});}
    if(!found.rows[0].deleted_at){await client.query('ROLLBACK');return res.status(409).json({error:'الحساب ليس في المحذوفات'});}
    await client.query('UPDATE mesh_accounts SET deleted_at=NULL,deleted_reason=NULL,updated_at=NOW() WHERE id=$1',[id]);
    await client.query(`INSERT INTO mesh_audit_logs(actor_id,action,target_id,details) VALUES($1,'account_restored_from_trash',$2,$3::jsonb)`,[adminActorId(req),id,JSON.stringify({role:found.rows[0].role})]);
    await client.query('COMMIT');res.json({ok:true,message:'تمت استعادة الحساب.'});
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
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
         VALUES ($1, 'account_suspended', $2, $3::jsonb)`, [adminActorId(req), id, JSON.stringify({ reason })]
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
         VALUES ($1, 'account_reactivated', $2, '{}'::jsonb)`, [adminActorId(req), id]
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
         VALUES ($1, 'account_closed', $2, $3::jsonb)`, [adminActorId(req), id, JSON.stringify({ reason })]
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
    // Remove all personal vehicle records; keep the driver financial profile and passenger debt ledger.
    await client.query('DELETE FROM mesh_driver_vehicles WHERE driver_id = $1', [id]);
    await client.query(
      `UPDATE mesh_driver_profiles SET car_type = '[محذوف]', car_model = '[محذوف]',
         car_color = '[محذوف]', plate_number = '[محذوف]', registration_number = '[محذوف]',
         vehicle_image_url = NULL, is_off_duty = TRUE
       WHERE account_id = $1`, [id]
    );
    await client.query(
      `UPDATE mesh_accounts SET national_id = NULL, full_name = 'حساب محذوف', phone = '',
         lifecycle_state = 'anonymized', anonymized_at = NOW(), anonymization_reason = 'تم تنفيذ الحذف النهائي بواسطة الإدارة',
         closure_reason = 'تم إغلاق الحساب قبل الحذف النهائي',
         status = 'blocked', status_before_block = NULL, updated_at = NOW()
       WHERE id = $1`, [id]
    );
    await client.query(
      `INSERT INTO mesh_audit_logs(actor_id, action, target_id, details)
       VALUES ($1, 'account_personal_data_anonymized', $2, $3::jsonb)`,
      [adminActorId(req), id, JSON.stringify({ reason: 'final_personal_data_erasure', tripsRetained: true, accountReferenceRetained: true, financialProfileRetained: true })]
    );
    await client.query('COMMIT');
    res.json({
      ok: true,
      message: 'تم حذف بيانات الهوية والاتصال وسجلات المركبات ورموز الدخول. حُفظت الأرصدة والالتزامات المالية وسجل الرحلات والتدقيق.',
      retained: ['سجل الرحلات والمبالغ والحالات', 'مرجع الحساب الداخلي اللازم للعلاقات', 'الأرصدة والالتزامات المالية', 'سجل التدقيق']
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
  const client = await pool.connect();
  let account;
  let code;
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id, role, status, phone FROM mesh_accounts WHERE id=$1 FOR UPDATE`, [id]
    );
    if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'الحساب غير موجود' }); }
    account = found.rows[0];
    if (account.status !== 'active') { await client.query('ROLLBACK'); return res.status(403).json({ error: 'اعتمد الحساب أولاً' }); }
    await client.query(`UPDATE mesh_otp_requests SET used_at=COALESCE(used_at,NOW()) WHERE account_id=$1 AND used_at IS NULL`, [id]);
    code = String(crypto.randomInt(100000, 1000000));
    const hash = await bcrypt.hash(code, 12);
    await client.query(`INSERT INTO mesh_otp_requests(account_id,otp_hash,expires_at)
      VALUES($1,$2,NOW()+INTERVAL '5 minutes')`, [id, hash]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }

  let delivery;
  try { delivery = await sendWhatsAppOtp(account.phone, code); }
  catch (error) { console.error('WhatsApp OTP delivery error:', error.message); delivery = { status: 'failed', reason: 'network_error' }; }
  await audit(adminActorId(req), 'issue_code', id, { delivery: delivery.status });
  if (delivery.status === 'sent') return res.json({ ok: true, delivery: 'sent', code, expiresInSeconds: 300,
    message: 'تم إرسال رمز التفعيل عبر واتساب. الرمز صالح لمدة 5 دقائق.' });
  return res.json({ ok: true, delivery: delivery.status, reason: delivery.reason || null,
    code, expiresInSeconds: 300,
    message: delivery.status === 'manual' ? 'الإرسال التلقائي متوقف؛ سلّم الرمز يدوياً.' : 'تعذر الإرسال عبر واتساب؛ سلّم الرمز يدوياً.' });
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
  } else {
    await pool.query(
      `INSERT INTO mesh_driver_vehicles
       (driver_id, car_type, car_model, car_color, plate_number, registration_number, vehicle_image_url, status, is_current)
       SELECT account_id, car_type, car_model, car_color, plate_number, registration_number,
         vehicle_image_url, 'approved', TRUE
       FROM mesh_driver_profiles WHERE account_id = $1
       AND NOT EXISTS (SELECT 1 FROM mesh_driver_vehicles WHERE driver_id = $1 AND is_current = TRUE)`, [id]
    );
  }
  await audit(adminActorId(req), 'driver_status', id, { status });
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
  await audit(adminActorId(req), 'passenger_status', id, { status });
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
    const messageCleanup = setInterval(() => {
      pool.query('DELETE FROM mesh_trip_messages WHERE expires_at <= NOW()').catch(error => console.error('Temporary chat cleanup failed:', error.message));
    }, 60 * 60 * 1000);
    messageCleanup.unref();
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      console.warn('Push notifications are not configured; set FIREBASE_SERVICE_ACCOUNT_JSON on the API service.');
    }
    if (!process.env.TURN_URLS || !process.env.TURN_SHARED_SECRET) {
      console.warn('Voice calls are using STUN only; configure TURN_URLS and TURN_SHARED_SECRET for reliable calls across restrictive mobile networks.');
    }
    const callCleanup = setInterval(() => {
      pool.query("UPDATE mesh_trip_calls SET status='expired',updated_at=NOW() WHERE status IN ('ringing','accepted') AND expires_at<=NOW()").catch(error => console.error('Trip call expiry cleanup failed:', error.message));
      pool.query("DELETE FROM mesh_trip_call_ice WHERE created_at < NOW() - INTERVAL '1 day'").catch(error => console.error('Trip call ICE cleanup failed:', error.message));
      pool.query("DELETE FROM mesh_trip_calls WHERE status IN ('rejected','ended','expired') AND updated_at < NOW() - INTERVAL '1 day'").catch(error => console.error('Trip call cleanup failed:', error.message));
    }, 10 * 60 * 1000);
    callCleanup.unref();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Meshwari API listening on ${PORT}`);
    });
  } catch (error) {
    console.error('Database startup failed:', error);
    process.exit(1);
  }
})();
