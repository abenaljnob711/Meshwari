'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { runMigrations } = require('../lib/migrations');
const { migrations } = require('../lib/schema-migrations');

const connectionString = process.env.MIGRATIONS_TEST_DATABASE_URL;

test('country pricing schema adds nullable settings and trip snapshots without inventing values', {
  skip: !connectionString && 'MIGRATIONS_TEST_DATABASE_URL is not configured'
}, async () => {
  const adminPool = new Pool({ connectionString, max: 1 });
  const schema = 'country_pricing_test_' + process.pid + '_' + Date.now();
  const schemaSql = '"' + schema.replace(/"/g, '""') + '"';
  let scopedPool;

  try {
    await adminPool.query('CREATE SCHEMA ' + schemaSql);
    scopedPool = new Pool({ connectionString, max: 1, options: '-c search_path=' + schema + ',public' });
    await scopedPool.query(`
      CREATE TABLE mesh_service_countries (
        country_code CHAR(2) PRIMARY KEY,
        country_name VARCHAR(120) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE mesh_trips (id BIGSERIAL PRIMARY KEY);
      INSERT INTO mesh_service_countries(country_code,country_name,enabled)
        VALUES ('YE','Yemen',TRUE);
      INSERT INTO mesh_trips DEFAULT VALUES;
    `);

    await runMigrations(scopedPool, migrations);
    await runMigrations(scopedPool, migrations);

    const country = await scopedPool.query(
      'SELECT currency_code,currency_minor_unit,base_fare,per_km_rate,commission_rate,cash_enabled,electronic_enabled FROM mesh_service_countries WHERE country_code=$1',
      ['YE']
    );
    assert.deepEqual(country.rows[0], {
      currency_code: null, currency_minor_unit: null, base_fare: null, per_km_rate: null,
      commission_rate: null, cash_enabled: null, electronic_enabled: null
    });

    const trip = await scopedPool.query(
      `SELECT country_code,currency_code,base_fare_snapshot,per_km_rate_snapshot,commission_rate_snapshot,
       currency_minor_unit_snapshot,payment_method,payment_provider,commission_amount_snapshot,driver_net_amount_snapshot FROM mesh_trips`
    );
    assert.deepEqual(trip.rows[0], {
      country_code: null, currency_code: null, base_fare_snapshot: null,
      per_km_rate_snapshot: null, commission_rate_snapshot: null, currency_minor_unit_snapshot: null,
      payment_method: null, payment_provider: null, commission_amount_snapshot: null, driver_net_amount_snapshot: null
    });

    // Verify migration 002 created the financial tables and that their
    // uniqueness, foreign-key, and value constraints are enforced by PostgreSQL.
    const applied = await scopedPool.query(
      'SELECT migration_id FROM mesh_schema_migrations ORDER BY migration_id'
    );
    assert.deepEqual(applied.rows.map(row => row.migration_id), [
      '001_country_pricing_snapshots',
      '002_trip_financial_foundation'
    ]);

    const financialTables = await scopedPool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema=current_schema()
         AND table_name IN ('mesh_trip_financial_ledger','mesh_trip_payment_attempts','mesh_payment_webhook_events')
       ORDER BY table_name`
    );
    assert.deepEqual(financialTables.rows.map(row => row.table_name), [
      'mesh_payment_webhook_events',
      'mesh_trip_financial_ledger',
      'mesh_trip_payment_attempts'
    ]);

    await scopedPool.query(
      `INSERT INTO mesh_trip_financial_ledger
       (trip_id,entry_type,amount,currency_code,reference_key)
       VALUES (1,'commission_debt',25.00,'YER','ledger-ref-1')`
    );
    await assert.rejects(
      scopedPool.query(
        `INSERT INTO mesh_trip_financial_ledger
         (trip_id,entry_type,amount,currency_code,reference_key)
         VALUES (1,'commission_debt',25.00,'YER','ledger-ref-1')`
      ),
      /unique constraint/
    );
    await assert.rejects(
      scopedPool.query(
        `INSERT INTO mesh_trip_financial_ledger
         (trip_id,entry_type,amount,currency_code,reference_key)
         VALUES (1,'unknown_entry',25.00,'YER','ledger-ref-2')`
      ),
      /check constraint/
    );
    await assert.rejects(
      scopedPool.query(
        `INSERT INTO mesh_trip_financial_ledger
         (trip_id,entry_type,amount,currency_code,reference_key)
         VALUES (1,'commission_debt',0,'YER','ledger-ref-3')`
      ),
      /check constraint/
    );

    await scopedPool.query(
      `INSERT INTO mesh_trip_payment_attempts
       (trip_id,provider,idempotency_key,amount,currency_code)
       VALUES (1,'test-provider','payment-key-1',100.00,'YER')`
    );
    await assert.rejects(
      scopedPool.query(
        `INSERT INTO mesh_trip_payment_attempts
         (trip_id,provider,idempotency_key,amount,currency_code)
         VALUES (1,'test-provider','payment-key-1',100.00,'YER')`
      ),
      /unique constraint/
    );
    await assert.rejects(
      scopedPool.query(
        `INSERT INTO mesh_trip_payment_attempts
         (trip_id,provider,idempotency_key,amount,currency_code,status)
         VALUES (1,'test-provider','payment-key-2',100.00,'YER','unknown')`
      ),
      /check constraint/
    );

    await scopedPool.query(
      `INSERT INTO mesh_payment_webhook_events(provider,provider_event_id,payload_hash)
       VALUES ('test-provider','event-1',repeat('a',64))`
    );
    await assert.rejects(
      scopedPool.query(
        `INSERT INTO mesh_payment_webhook_events(provider,provider_event_id,payload_hash)
         VALUES ('test-provider','event-1',repeat('b',64))`
      ),
      /unique constraint/
    );

    await assert.rejects(
      scopedPool.query("UPDATE mesh_service_countries SET currency_code='yeM' WHERE country_code='YE'"),
      /check constraint/
    );
    await assert.rejects(
      scopedPool.query('UPDATE mesh_service_countries SET base_fare=-1 WHERE country_code=$1', ['YE']),
      /check constraint/
    );
  } finally {
    if (scopedPool) await scopedPool.end();
    await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaSql + ' CASCADE');
    await adminPool.end();
  }
});
