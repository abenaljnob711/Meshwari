
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

const required = [
  'DATABASE_URL',
  'JWT_SECRET',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD_HASH'
];

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
  ssl: process.env.PGSSLMODE === 'disable'
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));

const origins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || origins.length === 0 || origins.includes(origin)) {
      return cb(null, true);
    }

    return cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));

const asyncHandler = fn =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const clean = (value, max = 200) =>
  String(value ?? '').trim().slice(0, max);

const validNationalId = value =>
  /^[0-9]{6,20}$/.test(String(value || ''));

const signToken = (sub, accountRole) =>
  jwt.sign(
    { sub: String(sub), role: accountRole },
    process.env.JWT_SECRET,
    {
      expiresIn: accountRole === 'admin' ? '4h' : '12h'
    }
  );

function auth(req, res, next) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'يلزم تسجيل الدخول'
    });
  }

  try {
    req.user = jwt.verify(
      header.slice(7),
      process.env.JWT_SECRET
    );

    next();
  } catch {
    return res.status(401).json({
      error: 'الجلسة غير صالحة، سجل الدخول مجدداً'
    });
  }
}

const role = (...allowed) => (req, res, next) => {
  if (!req.user || !allowed.includes(req.user.role)) {
    return res.status(403).json({
      error: 'ليس لديك صلاحية'
    });
  }

  next();
};

async function audit(actorId, action, targetId, details = {}) {
  await pool.query(
    `INSERT INTO mesh_audit_logs
      (actor_id, action, target_id, details)
     VALUES ($1, $2, $3, $4)`,
    [
      actorId && /^\d+$/.test(String(actorId))
        ? actorId
        : null,
      action,
      targetId || null,
      JSON.stringify(details)
    ]
  );
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mesh_accounts (
      id BIGSERIAL PRIMARY KEY,
      national_id VARCHAR(30) UNIQUE NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      phone VARCHAR(40) NOT NULL,
      role VARCHAR(20) NOT NULL
        CHECK (role IN ('passenger','driver')),
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','active','rejected','blocked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mesh_passenger_profiles (
      account_id BIGINT PRIMARY KEY
        REFERENCES mesh_accounts(id) ON DELETE CASCADE,
      customer_debt NUMERIC(12,2) NOT NULL DEFAULT 0,
      is_blocked BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS mesh_driver_profiles (
      account_id BIGINT PRIMARY KEY
        REFERENCES mesh_accounts(id) ON DELETE CASCADE,
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
      account_id BIGINT NOT NULL
        REFERENCES mesh_accounts(id) ON DELETE CASCADE,
      otp_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS mesh_otp_account_idx
      ON mesh_otp_requests(account_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS mesh_trips (
      id BIGSERIAL PRIMARY KEY,
      passenger_id BIGINT NOT NULL
        REFERENCES mesh_accounts(id),
      driver_id BIGINT
        REFERENCES mesh_accounts(id),
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

    INSERT INTO mesh_settings(setting_key, setting_value)
    VALUES ('base_fare','1000'),('per_km_rate','300')
    ON CONFLICT (setting_key) DO NOTHING;
  `);
}

/* Health */

app.get('/api/health', asyncHandler(async (req, res) => {
  await pool.query('SELECT 1');

  res.json({
    ok: true,
    service: 'Meshwari API',
    database: 'connected'
  });
}));

/* Registration */

app.post('/api/register', asyncHandler(async (req, res) => {
  const requestedRole = req.body?.role;
  const nationalId = clean(req.body?.nationalId, 30);
  const fullName = clean(req.body?.fullName, 150);
  const phone = clean(req.body?.phone, 40);

  if (
    !['passenger', 'driver'].includes(requestedRole) ||
    !validNationalId(nationalId) ||
    !fullName ||
    !phone
  ) {
    return res.status(400).json({
      error: 'تحقق من نوع الحساب والاسم ورقم البطاقة والجوال'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const old = await client.query(
      `SELECT id, role, status
       FROM mesh_accounts
       WHERE national_id = $1
       FOR UPDATE`,
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
        clean(car.type, 120),
        clean(car.model, 120),
        clean(car.color, 120),
        clean(car.plateNumber, 120),
        clean(car.registrationNumber, 120)
      ];

      if (carValues.some(value => !value)) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error: 'أكمل بيانات السيارة والملكية واللوحة'
        });
      }
    }

    const inserted = await client.query(
      `INSERT INTO mesh_accounts
        (national_id, full_name, phone, role, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [nationalId, fullName, phone, requestedRole]
    );

    const id = inserted.rows[0].id;

    if (requestedRole === 'passenger') {
      await client.query(
        `INSERT INTO mesh_passenger_profiles(account_id)
         VALUES ($1)`,
        [id]
      );
    } else {
      await client.query(
        `INSERT INTO mesh_driver_profiles
          (account_id, car_type, car_model, car_color,
           plate_number, registration_number)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, ...carValues]
      );
    }

    await client.query('COMMIT');

    await audit(null, `${requestedRole}_registration`, id);

    return res.status(201).json({
      ok: true,
      status: 'pending',
      message: 'تم استلام طلبك وهو قيد مراجعة الإدارة'
    });

  } catch (error) {
    await client.query('ROLLBACK');

    if (error.code === '23505') {
      return res.status(409).json({
        error: 'الحساب مسجل مسبقاً'
      });
    }

    throw error;

  } finally {
    client.release();
  }
}));

/* Login code request */

app.post('/api/auth/request-code', asyncHandler(async (req, res) => {
  const nationalId = clean(req.body?.nationalId, 30);

  if (!validNationalId(nationalId)) {
    return res.status(400).json({
      error: 'رقم البطاقة غير صحيح'
    });
  }

  const result = await pool.query(
    `SELECT id, role, status
     FROM mesh_accounts
     WHERE national_id = $1`,
    [nationalId]
  );

  if (!result.rowCount) {
    return res.status(404).json({
      error: 'الحساب غير موجود'
    });
  }

  const account = result.rows[0];

  if (['blocked', 'rejected'].includes(account.status)) {
    return res.status(403).json({
      error: 'الحساب موقوف أو مرفوض'
    });
  }

  if (account.status !== 'active') {
    return res.status(403).json({
      error: 'الحساب بانتظار اعتماد الإدارة'
    });
  }

  res.json({
    ok: true,
    message: 'تم تسجيل طلبك. اطلب رمز الدخول من الإدارة'
  });
}));

/* Verify one-time login code */

app.post('/api/auth/verify-code', asyncHandler(async (req, res) => {
  const nationalId = clean(req.body?.nationalId, 30);
  const code = clean(req.body?.code, 6);

  if (
    !validNationalId(nationalId) ||
    !/^\d{6}$/.test(code)
  ) {
    return res.status(400).json({
      error: 'بيانات التحقق غير صحيحة'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const accountResult = await client.query(
      `SELECT *
       FROM mesh_accounts
       WHERE national_id = $1
       FOR UPDATE`,
      [nationalId]
    );

    if (!accountResult.rowCount) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'الحساب غير موجود'
      });
    }

    const account = accountResult.rows[0];

    if (account.status !== 'active') {
      await client.query('ROLLBACK');

      return res.status(403).json({
        error: account.status === 'pending'
          ? 'الحساب بانتظار اعتماد الإدارة'
          : 'الحساب غير مسموح له بالدخول'
      });
    }

    const otpResult = await client.query(
      `SELECT *
       FROM mesh_otp_requests
       WHERE account_id = $1
         AND used_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [account.id]
    );

    if (!otpResult.rowCount) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'لا يوجد رمز صالح'
      });
    }

    const otp = otpResult.rows[0];

    if (
      new Date(otp.expires_at) < new Date() ||
      otp.attempts >= 5
    ) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'انتهت صلاحية الرمز'
      });
    }

    const validCode = await bcrypt.compare(
      code,
      otp.otp_hash
    );

    if (!validCode) {
      await client.query(
        `UPDATE mesh_otp_requests
         SET attempts = attempts + 1
         WHERE id = $1`,
        [otp.id]
      );

      await client.query('COMMIT');

      return res.status(400).json({
        error: 'الرمز غير صحيح'
      });
    }

    await client.query(
      `UPDATE mesh_otp_requests
       SET used_at = NOW()
       WHERE id = $1`,
      [otp.id]
    );

    await client.query('COMMIT');

    await audit(account.id, 'login', account.id);

    res.json({
      ok: true,
      token: signToken(account.id, account.role),
      account: {
        id: account.id,
        fullName: account.full_name,
        full_name: account.full_name,
        nationalId: account.national_id,
        phone: account.phone,
        role: account.role,
        status: account.status
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
    return res.status(403).json({
      error: 'غير مسموح'
    });
  }

  const result = await pool.query(
    `SELECT
       a.id,
       a.national_id,
       a.full_name,
       a.phone,
       a.role,
       a.status,
       p.customer_debt,
       p.is_blocked,
       d.car_type,
       d.car_model,
       d.car_color,
       d.plate_number,
       d.registration_number,
       d.vehicle_image_url,
       d.wallet_balance,
       d.withdrawable_balance,
       d.is_off_duty
     FROM mesh_accounts a
     LEFT JOIN mesh_passenger_profiles p
       ON p.account_id = a.id
     LEFT JOIN mesh_driver_profiles d
       ON d.account_id = a.id
     WHERE a.id = $1`,
    [req.user.sub]
  );

  if (
    !result.rowCount ||
    result.rows[0].role !== req.user.role ||
    result.rows[0].status !== 'active'
  ) {
    return res.status(403).json({
      error: 'الحساب غير نشط أو الدور غير مطابق'
    });
  }

  const account = result.rows[0];

  if (account.role === 'driver') {
    account.fullName = account.full_name;
    account.car_plate = account.plate_number;
    account.is_on_duty = !account.is_off_duty;
    account.isOnDuty = !account.is_off_duty;
    account.walletBalance = account.wallet_balance;
  } else {
    account.fullName = account.full_name;
    account.nationalId = account.national_id;
  }

  res.json({ account });
}));

/* Public application settings */

app.get('/api/settings', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT setting_key, setting_value
     FROM mesh_settings`
  );

  res.json({
    settings: Object.fromEntries(
      result.rows.map(row => [
        row.setting_key,
        Number(row.setting_value)
      ])
    )
  });
}));

/* Passenger creates a trip request */

app.post(
  '/api/trips',
  auth,
  role('passenger'),
  asyncHandler(async (req, res) => {
    const destination = clean(req.body?.destination, 500);

    if (!destination) {
      return res.status(400).json({
        error: 'أدخل الوجهة'
      });
    }

    const account = await pool.query(
      `SELECT status
       FROM mesh_accounts
       WHERE id = $1 AND role = 'passenger'`,
      [req.user.sub]
    );

    if (
      !account.rowCount ||
      account.rows[0].status !== 'active'
    ) {
      return res.status(403).json({
        error: 'الحساب غير نشط'
      });
    }

    const settings = await pool.query(
      `SELECT setting_key, setting_value
       FROM mesh_settings
       WHERE setting_key IN ('base_fare','per_km_rate')`
    );

    const config = Object.fromEntries(
      settings.rows.map(row => [
        row.setting_key,
        Number(row.setting_value)
      ])
    );

    // تقدير توضيحي مؤقت، وليس تسعيرًا نهائيًا عبر GPS.
    const distance = 5;
    const fare =
      (config.base_fare || 1000) +
      (config.per_km_rate || 300) * distance;

    const trip = await pool.query(
      `INSERT INTO mesh_trips
        (passenger_id, dropoff_address, distance_km, fare_amount)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.sub, destination, distance, fare]
    );

    res.status(201).json({
      ok: true,
      trip: trip.rows[0],
      estimated: true
    });
  })
);

/* Driver duty state */

app.put(
  '/api/driver/duty',
  auth,
  role('driver'),
  asyncHandler(async (req, res) => {
    let offDuty;

    // يدعم الصيغة القديمة offDuty وصيغة واجهة السائق is_on_duty.
    if (typeof req.body?.offDuty === 'boolean') {
      offDuty = req.body.offDuty;
    } else if (typeof req.body?.is_on_duty === 'boolean') {
      offDuty = !req.body.is_on_duty;
    } else {
      return res.status(400).json({
        error: 'حالة الدوام غير صحيحة'
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const account = await client.query(
        `SELECT id, status
         FROM mesh_accounts
         WHERE id = $1 AND role = 'driver'
         FOR UPDATE`,
        [req.user.sub]
      );

      if (!account.rowCount) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error: 'حساب السائق غير موجود'
        });
      }

      if (account.rows[0].status !== 'active') {
        await client.query('ROLLBACK');

        return res.status(403).json({
          error: 'السائق غير معتمد أو حسابه موقوف'
        });
      }

      const profile = await client.query(
        `UPDATE mesh_driver_profiles
         SET is_off_duty = $1
         WHERE account_id = $2
         RETURNING is_off_duty`,
        [offDuty, req.user.sub]
      );

      if (!profile.rowCount) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          error: 'بيانات مركبة السائق غير موجودة'
        });
      }

      await client.query('COMMIT');

      res.json({
        ok: true,
        offDuty,
        is_off_duty: offDuty,
        is_on_duty: !offDuty
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;

    } finally {
      client.release();
    }
  })
);

/* Administration login */

app.post(
  '/api/admin/login',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false
  }),
  asyncHandler(async (req, res) => {
    const username = clean(req.body?.username, 100);
    const password = String(req.body?.password || '');

    const valid =
      username === process.env.ADMIN_USERNAME &&
      await bcrypt.compare(
        password,
        process.env.ADMIN_PASSWORD_HASH
      );

    if (!valid) {
      return res.status(401).json({
        error: 'بيانات الدخول غير صحيحة'
      });
    }

    res.json({
      ok: true,
      token: signToken('admin', 'admin')
    });
  })
);

/* Administration overview */

app.get(
  '/api/admin/overview',
  auth,
  role('admin'),
  asyncHandler(async (req, res) => {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM mesh_accounts
         WHERE role = 'passenger') passengers,

        (SELECT COUNT(*) FROM mesh_accounts
         WHERE role = 'driver') drivers,

        (SELECT COUNT(*) FROM mesh_accounts
         WHERE role = 'driver' AND status = 'active') active_drivers,

        (SELECT COUNT(*) FROM mesh_accounts
         WHERE status = 'pending') pending_accounts,

        (SELECT COUNT(*) FROM mesh_trips) trips
    `);

    res.json({ overview: result.rows[0] });
  })
);

/* Administration accounts */

app.get(
  '/api/admin/accounts',
  auth,
  role('admin'),
  asyncHandler(async (req, res) => {
    const result = await pool.query(`
      SELECT
        a.id,
        a.national_id,
        a.full_name,
        a.phone,
        a.role,
        a.status,
        a.created_at,
        d.car_type,
        d.car_model,
        d.car_color,
        d.plate_number,
        d.registration_number,
        d.wallet_balance
      FROM mesh_accounts a
      LEFT JOIN mesh_driver_profiles d
        ON d.account_id = a.id
      ORDER BY a.created_at DESC
    `);

    res.json({ accounts: result.rows });
  })
);

/* Admin issues one-time code */

app.post(
  '/api/admin/accounts/:id/issue-code',
  auth,
  role('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        error: 'معرف غير صحيح'
      });
    }

    const account = await pool.query(
      `SELECT id, role, status
       FROM mesh_accounts
       WHERE id = $1`,
      [id]
    );

    if (!account.rowCount) {
      return res.status(404).json({
        error: 'الحساب غير موجود'
      });
    }

    if (account.rows[0].status !== 'active') {
      return res.status(403).json({
        error: 'اعتمد الحساب أولاً'
      });
    }

    const code = String(
      crypto.randomInt(100000, 1000000)
    );

    const hash = await bcrypt.hash(code, 12);

    await pool.query(
      `INSERT INTO mesh_otp_requests
        (account_id, otp_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
      [id, hash]
    );

    await audit('admin', 'issue_code', id);

    res.json({
      ok: true,
      code,
      expiresInSeconds: 300
    });
  })
);

/* Admin changes driver status */

app.patch(
  '/api/admin/drivers/:id/status',
  auth,
  role('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const status = clean(req.body?.status, 20);

    if (
      !Number.isSafeInteger(id) ||
      !['active', 'rejected', 'blocked'].includes(status)
    ) {
      return res.status(400).json({
        error: 'بيانات غير صحيحة'
      });
    }

    const result = await pool.query(
      `UPDATE mesh_accounts
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND role = 'driver'
       RETURNING id, status`,
      [status, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: 'السائق غير موجود'
      });
    }

    // عند إيقاف السائق، يمنع استقبال رحلات جديدة.
    if (status !== 'active') {
      await pool.query(
        `UPDATE mesh_driver_profiles
         SET is_off_duty = TRUE
         WHERE account_id = $1`,
        [id]
      );
    }

    await audit('admin', 'driver_status', id, { status });

    res.json({
      ok: true,
      account: result.rows[0]
    });
  })
);

/* Admin changes passenger status */

app.patch(
  '/api/admin/passengers/:id/status',
  auth,
  role('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const status = clean(req.body?.status, 20);

    if (
      !Number.isSafeInteger(id) ||
      !['active', 'blocked', 'rejected'].includes(status)
    ) {
      return res.status(400).json({
        error: 'بيانات غير صحيحة'
      });
    }

    const result = await pool.query(
      `UPDATE mesh_accounts
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND role = 'passenger'
       RETURNING id, status`,
      [status, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: 'الراكب غير موجود'
      });
    }

    await audit('admin', 'passenger_status', id, { status });

    res.json({
      ok: true,
      account: result.rows[0]
    });
  })
);

/* Administration trips */

app.get(
  '/api/admin/trips',
  auth,
  role('admin'),
  asyncHandler(async (req, res) => {
    const result = await pool.query(`
      SELECT
        t.*,
        p.full_name AS passenger_name,
        d.full_name AS driver_name
      FROM mesh_trips t
      JOIN mesh_accounts p
        ON p.id = t.passenger_id
      LEFT JOIN mesh_accounts d
        ON d.id = t.driver_id
      ORDER BY t.created_at DESC
      LIMIT 500
    `);

    res.json({ trips: result.rows });
  })
);

/* Administration audit log */

app.get(
  '/api/admin/audit',
  auth,
  role('admin'),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT *
       FROM mesh_audit_logs
       ORDER BY created_at DESC
       LIMIT 500`
    );

    res.json({ logs: result.rows });
  })
);

/* Static pages */

app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

app.use((err, req, res, next) => {
  console.error('API error:', err.message);

  if (res.headersSent) {
    return next(err);
  }

  res.status(
    err.message === 'Origin not allowed' ? 403 : 500
  ).json({
    error: err.message === 'Origin not allowed'
      ? 'المصدر غير مسموح'
      : 'حدث خطأ داخلي في الخادم'
  });
});

/* Start server */

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
