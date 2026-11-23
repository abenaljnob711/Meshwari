'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { runMigrations } = require('../lib/migrations');

const connectionString = process.env.MIGRATIONS_TEST_DATABASE_URL;

test('PostgreSQL migration runner is atomic, repeatable and checksum-protected', {
  skip: !connectionString && 'MIGRATIONS_TEST_DATABASE_URL is not configured'
}, async () => {
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const schema = 'migration_test_' + process.pid + '_' + Date.now();
  const schemaSql = '"' + schema.replace(/"/g, '""') + '"';

  try {
    await client.query('CREATE SCHEMA ' + schemaSql);
    await client.query('SET search_path TO ' + schemaSql + ', public');

    const scopedPool = { connect: async () => client };
    const migrations = [{
      id: '001_create_probe',
      sql: 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL)'
    }];

    await runMigrations(scopedPool, migrations);
    let result = await client.query(
      "SELECT migration_id FROM mesh_schema_migrations WHERE migration_id='001_create_probe'"
    );
    assert.equal(result.rowCount, 1);

    await runMigrations(scopedPool, migrations);
    result = await client.query('SELECT COUNT(*)::int AS count FROM migration_probe');
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

    result = await client.query(
      "SELECT COUNT(*)::int AS count FROM mesh_schema_migrations WHERE migration_id='002_failure'"
    );
    assert.equal(result.rows[0].count, 0);

    result = await client.query(
      "SELECT to_regclass('migration_failure') AS relation"
    );
    assert.equal(result.rows[0].relation, null);
  } finally {
    try {
      await client.query('RESET search_path');
      await client.query('DROP SCHEMA IF EXISTS ' + schemaSql + ' CASCADE');
    } finally {
      client.release();
      await pool.end();
    }
  }
});
