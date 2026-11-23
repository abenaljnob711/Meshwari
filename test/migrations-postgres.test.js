'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { runMigrations } = require('../lib/migrations');

const connectionString = process.env.MIGRATIONS_TEST_DATABASE_URL;

test('PostgreSQL migration runner is atomic, repeatable and checksum-protected', {
  skip: !connectionString && 'MIGRATIONS_TEST_DATABASE_URL is not configured'
}, async () => {
  const adminPool = new Pool({ connectionString, max: 1 });
  const schema = 'migration_test_' + process.pid + '_' + Date.now();
  const schemaSql = '"' + schema.replace(/"/g, '""') + '"';
  let scopedPool;

  try {
    await adminPool.query('CREATE SCHEMA ' + schemaSql);
    scopedPool = new Pool({
      connectionString,
      max: 1,
      options: '-c search_path=' + schema + ',public'
    });

    const migrations = [{
      id: '001_create_probe',
      sql: 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL)'
    }];

    await runMigrations(scopedPool, migrations);
    let result = await scopedPool.query(
      "SELECT migration_id FROM mesh_schema_migrations WHERE migration_id='001_create_probe'"
    );
    assert.equal(result.rowCount, 1);

    await runMigrations(scopedPool, migrations);
    result = await scopedPool.query('SELECT COUNT(*)::int AS count FROM migration_probe');
    assert.equal(result.rows[0].count, 0);

    await assert.rejects(
      runMigrations(scopedPool, [{
        id: '001_create_probe',
        sql: 'CREATE TABLE migration_probe (id BIGINT PRIMARY KEY)'
      }]),
      /checksum mismatch/
    );

    await assert.rejects(
      runMigrations(scopedPool, [{
        id: '002_failure',
        sql: 'CREATE TABLE migration_failure (id INTEGER); SELECT * FROM table_that_does_not_exist'
      }]),
      /does not exist/
    );

    result = await scopedPool.query(
      "SELECT COUNT(*)::int AS count FROM mesh_schema_migrations WHERE migration_id='002_failure'"
    );
    assert.equal(result.rows[0].count, 0);

    result = await scopedPool.query("SELECT to_regclass('migration_failure') AS relation");
    assert.equal(result.rows[0].relation, null);
  } finally {
    if (scopedPool) await scopedPool.end();
    await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaSql + ' CASCADE');
    await adminPool.end();
  }
});


test('actual Meshwari schema migrations apply cleanly on PostgreSQL', {
  skip: !connectionString && 'MIGRATIONS_TEST_DATABASE_URL is not configured'
}, async () => {
  const adminPool = new Pool({ connectionString, max: 1 });
  const schema = 'meshwari_schema_' + process.pid + '_' + Date.now();
  const schemaSql = '"' + schema.replace(/"/g, '""') + '"';
  let scopedPool;
  try {
    await adminPool.query('CREATE SCHEMA ' + schemaSql);
    scopedPool = new Pool({
      connectionString,
      max: 1,
      options: '-c search_path=' + schema + ',public'
    });
    await scopedPool.query(`
      CREATE TABLE mesh_accounts (id BIGSERIAL PRIMARY KEY);
      CREATE TABLE mesh_passenger_profiles (
        account_id BIGINT PRIMARY KEY REFERENCES mesh_accounts(id),
        customer_debt NUMERIC(12,2) NOT NULL DEFAULT 0
      );
      CREATE TABLE mesh_driver_profiles (
        account_id BIGINT PRIMARY KEY REFERENCES mesh_accounts(id),
        wallet_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
        withdrawable_balance NUMERIC(12,2) NOT NULL DEFAULT 0
      );
      CREATE TABLE mesh_driver_wallet_transactions (
        id BIGSERIAL PRIMARY KEY,
        driver_id BIGINT NOT NULL REFERENCES mesh_accounts(id),
        amount NUMERIC(12,2) NOT NULL,
        balance_after NUMERIC(12,2) NOT NULL
      );
      CREATE TABLE mesh_service_countries (
        country_code CHAR(2) PRIMARY KEY,
        country_name VARCHAR(120) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE mesh_trips (
        id BIGSERIAL PRIMARY KEY,
        passenger_id BIGINT NOT NULL REFERENCES mesh_accounts(id),
        driver_id BIGINT REFERENCES mesh_accounts(id),
        status VARCHAR(30) NOT NULL DEFAULT 'requested',
        fare_amount NUMERIC(12,2) NOT NULL DEFAULT 0
      );
    `);
    const { migrations } = require('../lib/schema-migrations');
    await runMigrations(scopedPool, migrations);
    const checks = await scopedPool.query(`
      SELECT
        (SELECT data_type FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='mesh_trips' AND column_name='fare_amount') AS fare_type,
        (SELECT data_type FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='mesh_driver_profiles' AND column_name='wallet_balance') AS wallet_type,
        to_regclass($2) AS ledger_table,
        to_regclass($3) AS attempts_table
    `, [schema, schema + '.mesh_trip_financial_ledger', schema + '.mesh_trip_payment_attempts']);
    assert.equal(checks.rows[0].fare_type, 'numeric');
    assert.equal(checks.rows[0].wallet_type, 'numeric');
    assert.ok(checks.rows[0].ledger_table);
    assert.ok(checks.rows[0].attempts_table);
    const precision = await scopedPool.query(`
      SELECT numeric_precision,numeric_scale FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='mesh_trips' AND column_name='fare_amount'
    `, [schema]);
    assert.equal(precision.rows[0].numeric_precision, 18);
    assert.equal(precision.rows[0].numeric_scale, 4);
    const applied = await scopedPool.query('SELECT COUNT(*)::int AS count FROM mesh_schema_migrations');
    assert.equal(applied.rows[0].count, migrations.length);
  } finally {
    if (scopedPool) await scopedPool.end();
    await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaSql + ' CASCADE');
    await adminPool.end();
  }
});
