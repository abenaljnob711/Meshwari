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
