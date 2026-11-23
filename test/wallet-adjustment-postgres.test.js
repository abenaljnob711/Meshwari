'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { applyAdminWalletAdjustment } = require('../lib/wallet-adjustment');

const connectionString = process.env.MIGRATIONS_TEST_DATABASE_URL;

test('admin wallet adjustment is idempotent under concurrent PostgreSQL retries', {
  skip: !connectionString && 'MIGRATIONS_TEST_DATABASE_URL is not configured'
}, async () => {
  const adminPool = new Pool({ connectionString, max: 4 });
  const schema = 'wallet_idem_' + process.pid + '_' + Date.now();
  const schemaSql = '"' + schema.replace(/"/g, '""') + '"';
  let pool;

  try {
    await adminPool.query('CREATE SCHEMA ' + schemaSql);
    pool = new Pool({ connectionString, max: 4, options: '-c search_path=' + schema + ',public' });
    await pool.query(`CREATE TABLE mesh_accounts(
      id BIGINT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL, lifecycle_state TEXT NOT NULL
    )`);
    await pool.query(`CREATE TABLE mesh_driver_profiles(
      account_id BIGINT PRIMARY KEY REFERENCES mesh_accounts(id),
      wallet_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      withdrawable_balance NUMERIC(12,2) NOT NULL DEFAULT 0
    )`);
    await pool.query(`CREATE TABLE mesh_driver_wallet_transactions(
      id BIGSERIAL PRIMARY KEY, driver_id BIGINT NOT NULL, amount NUMERIC(12,2) NOT NULL,
      balance_after NUMERIC(12,2) NOT NULL, transaction_type VARCHAR(40) NOT NULL,
      description TEXT NOT NULL, reference_key VARCHAR(160) UNIQUE, created_by VARCHAR(80),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE mesh_audit_logs(
      id BIGSERIAL PRIMARY KEY, actor_id BIGINT, action TEXT NOT NULL, target_id BIGINT, details JSONB NOT NULL
    )`);
    await pool.query("INSERT INTO mesh_accounts(id,role,status,lifecycle_state) VALUES(7,'driver','active','open')");
    await pool.query('INSERT INTO mesh_driver_profiles(account_id,wallet_balance) VALUES(7,100)');

    const input = {
      driverId: 7, amount: 25, description: 'تسوية اختبار',
      requestKey: '123e4567-e89b-42d3-a456-426614174000',
      adminId: '1', auditActorId: '1'
    };

    const results = await Promise.all([
      applyAdminWalletAdjustment(pool, input),
      applyAdminWalletAdjustment(pool, input)
    ]);
    assert.equal(results.filter(result => result.replayed).length, 1);
    assert.equal(results.filter(result => !result.replayed).length, 1);

    let result = await pool.query('SELECT wallet_balance FROM mesh_driver_profiles WHERE account_id=7');
    assert.equal(Number(result.rows[0].wallet_balance), 125);
    result = await pool.query('SELECT COUNT(*)::int AS count FROM mesh_driver_wallet_transactions');
    assert.equal(result.rows[0].count, 1);
    result = await pool.query('SELECT COUNT(*)::int AS count FROM mesh_audit_logs');
    assert.equal(result.rows[0].count, 1);

    await assert.rejects(
      applyAdminWalletAdjustment(pool, { ...input, amount: 30 }),
      error => error.status === 409
    );

    result = await pool.query('SELECT wallet_balance FROM mesh_driver_profiles WHERE account_id=7');
    assert.equal(Number(result.rows[0].wallet_balance), 125);

    // An audit failure must roll back both the wallet balance and ledger row.
    await assert.rejects(
      applyAdminWalletAdjustment(pool, {
        ...input,
        amount: 10,
        requestKey: '123e4567-e89b-42d3-a456-426614174001',
        auditActorId: 'not-a-bigint'
      })
    );
    result = await pool.query('SELECT wallet_balance FROM mesh_driver_profiles WHERE account_id=7');
    assert.equal(Number(result.rows[0].wallet_balance), 125);
    result = await pool.query('SELECT COUNT(*)::int AS count FROM mesh_driver_wallet_transactions');
    assert.equal(result.rows[0].count, 1);
    result = await pool.query('SELECT COUNT(*)::int AS count FROM mesh_audit_logs');
    assert.equal(result.rows[0].count, 1);
  } finally {
    if (pool) await pool.end();
    await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaSql + ' CASCADE');
    await adminPool.end();
  }
});
