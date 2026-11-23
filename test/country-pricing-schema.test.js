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
      'SELECT currency_code,currency_minor_unit,base_fare,per_km_rate FROM mesh_service_countries WHERE country_code=$1',
      ['YE']
    );
    assert.deepEqual(country.rows[0], {
      currency_code: null, currency_minor_unit: null, base_fare: null, per_km_rate: null
    });

    const trip = await scopedPool.query(
      'SELECT country_code,currency_code,base_fare_snapshot,per_km_rate_snapshot,commission_rate_snapshot FROM mesh_trips'
    );
    assert.deepEqual(trip.rows[0], {
      country_code: null, currency_code: null, base_fare_snapshot: null,
      per_km_rate_snapshot: null, commission_rate_snapshot: null
    });

    await assert.rejects(
      scopedPool.query("UPDATE mesh_service_countries SET currency_code='YEM' WHERE country_code='YE'"),
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
