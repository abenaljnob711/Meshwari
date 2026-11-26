'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { runMigrations } = require('../lib/migrations');
const { recordCashTripCommission } = require('../lib/record-cash-trip-commission');
const { recordDriverCashCollection } = require('../lib/wallet-collection');
const { applyAdminWalletAdjustment } = require('../lib/wallet-adjustment');

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
      CREATE TABLE mesh_accounts (
        id BIGSERIAL PRIMARY KEY,
        role VARCHAR(20) NOT NULL DEFAULT 'driver',
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        lifecycle_state VARCHAR(20) NOT NULL DEFAULT 'open'
      );
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
        balance_after NUMERIC(12,2) NOT NULL,
        transaction_type VARCHAR(40) NOT NULL,
        description TEXT NOT NULL,
        reference_key VARCHAR(160) UNIQUE,
        created_by VARCHAR(80)
      );
      CREATE TABLE mesh_service_countries (
        country_code CHAR(2) PRIMARY KEY,
        country_name VARCHAR(120) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE mesh_audit_logs (
        id BIGSERIAL PRIMARY KEY,
        actor_id BIGINT,
        action VARCHAR(120) NOT NULL,
        target_id BIGINT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

    // Exercise the actual cash commission service against PostgreSQL, including
    // duplicate execution in the same transaction.
    await scopedPool.query(`
      INSERT INTO mesh_accounts(id) VALUES (1),(2);
      INSERT INTO mesh_service_countries(country_code,country_name,enabled,currency_code,currency_minor_unit)
      VALUES ('US','Test Country',TRUE,'USD',2);
      INSERT INTO mesh_driver_profiles(account_id,wallet_balance,withdrawable_balance)
      VALUES (2,0,0);
      INSERT INTO mesh_trips
        (passenger_id,driver_id,status,fare_amount,country_code,currency_code,
         currency_minor_unit_snapshot,commission_rate_snapshot,payment_method)
      VALUES (1,2,'completed',100.00,'US','USD',2,10,'cash');
    `);
    const trip = (await scopedPool.query(
      `SELECT id,driver_id,status,fare_amount,currency_code,currency_minor_unit_snapshot,
              commission_rate_snapshot,payment_method
       FROM mesh_trips WHERE passenger_id=1`
    )).rows[0];
    const client = await scopedPool.connect();
    try {
      await client.query('BEGIN');
      await recordCashTripCommission(client, trip);
      await recordCashTripCommission(client, trip);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const financialState = await scopedPool.query(`
      SELECT d.wallet_balance::text AS legacy_wallet_balance,
        (SELECT balance::text FROM mesh_driver_wallet_accounts
         WHERE driver_id=d.account_id AND currency_code='USD') AS currency_wallet_balance,
        (SELECT COUNT(*)::int FROM mesh_trip_financial_ledger WHERE trip_id=$1) AS ledger_count,
        (SELECT COUNT(*)::int FROM mesh_driver_wallet_transactions
         WHERE reference_key='trip:'||$1||':commission-debt') AS wallet_transaction_count,
        (SELECT amount::text FROM mesh_driver_wallet_transactions
         WHERE reference_key='trip:'||$1||':commission-debt') AS wallet_transaction_amount
      FROM mesh_driver_profiles d WHERE d.account_id=2
    `, [trip.id]);
    assert.equal(financialState.rows[0].legacy_wallet_balance, '0.0000');
    assert.equal(financialState.rows[0].currency_wallet_balance, '-10.0000');
    assert.equal(financialState.rows[0].ledger_count, 1);
    assert.equal(financialState.rows[0].wallet_transaction_count, 1);
    assert.equal(financialState.rows[0].wallet_transaction_amount, '-10.0000');

    // Exercise real PostgreSQL cash collection: partial collection, idempotent replay,
    // and rejection when the requested amount exceeds the remaining currency debt.
    const collectionInput = {
      driverId: 2, amount: '4.0000', currencyCode: 'USD',
      description: 'Integration test collection',
      requestKey: 'pg-collection-' + process.pid + '-' + Date.now(),
      adminId: 'integration-admin', auditActorId: 1
    };
    const duplicateResults = await Promise.all([
      recordDriverCashCollection(scopedPool, collectionInput),
      recordDriverCashCollection(scopedPool, collectionInput)
    ]);
    assert.deepEqual(duplicateResults.map(x => x.replayed).sort(), [false, true]);
    assert.ok(duplicateResults.every(x => x.wallet.wallet_balance === '-6.0000'));

    await assert.rejects(
      recordDriverCashCollection(scopedPool, {
        ...collectionInput,
        amount: '7.0000',
        requestKey: collectionInput.requestKey + '-too-large'
      }),
      /مبلغ التحصيل/
    );

    const competingCollections = await Promise.allSettled([
      recordDriverCashCollection(scopedPool, {
        ...collectionInput, amount: '4.0000', requestKey: collectionInput.requestKey + '-race-a'
      }),
      recordDriverCashCollection(scopedPool, {
        ...collectionInput, amount: '4.0000', requestKey: collectionInput.requestKey + '-race-b'
      })
    ]);
    assert.equal(competingCollections.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(competingCollections.filter(x => x.status === 'rejected').length, 1);

    const collectionState = await scopedPool.query(`
      SELECT d.balance::text AS wallet_balance,
        (SELECT COUNT(*)::int FROM mesh_driver_wallet_transactions
         WHERE driver_id=2 AND transaction_type='cash_collection') AS collection_count,
        (SELECT COUNT(*)::int FROM mesh_audit_logs
         WHERE action='driver_wallet_cash_collection') AS audit_count
      FROM mesh_driver_wallet_accounts d
      WHERE d.driver_id=2 AND d.currency_code='USD'
    `);
    assert.equal(collectionState.rows[0].wallet_balance, '-2.0000');
    assert.equal(collectionState.rows[0].collection_count, 2);
    assert.equal(collectionState.rows[0].audit_count, 2);

    // A second currency must maintain an independent balance and idempotent adjustment.
    await scopedPool.query(`
      INSERT INTO mesh_service_countries(country_code,country_name,enabled,currency_code,currency_minor_unit)
      VALUES ('GB','Second Test Country',TRUE,'EUR',2)
    `);
    const adjustmentInput = {
      driverId: 2, amount: '50.00', currencyCode: 'EUR',
      description: 'Integration test EUR adjustment',
      requestKey: 'pg-adjustment-' + process.pid + '-' + Date.now(),
      adminId: 'integration-admin', auditActorId: 1
    };
    const adjustment = await applyAdminWalletAdjustment(scopedPool, adjustmentInput);
    assert.equal(adjustment.wallet.wallet_balance, '50.0000');
    assert.equal(adjustment.replayed, false);
    const adjustmentReplay = await applyAdminWalletAdjustment(scopedPool, adjustmentInput);
    assert.equal(adjustmentReplay.replayed, true);
    assert.equal(adjustmentReplay.wallet.wallet_balance, '50.0000');

    const currencyIsolation = await scopedPool.query(`
      SELECT currency_code,balance::text AS balance FROM mesh_driver_wallet_accounts
      WHERE driver_id=2 ORDER BY currency_code
    `);
    assert.deepEqual(currencyIsolation.rows, [
      {currency_code:'EUR',balance:'50.0000'},
      {currency_code:'USD',balance:'-2.0000'}
    ]);
  } finally {
    if (scopedPool) await scopedPool.end();
    await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaSql + ' CASCADE');
    await adminPool.end();
  }
});
