'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { migrationChecksum, validateMigrations, runMigrations } = require('../lib/migrations');

function fakePool({ applied = [], failSql = null } = {}) {
  const calls = [];
  const rows = [...applied];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql).trim(), params });
      const normalized = String(sql).trim();
      if (normalized.startsWith('SELECT migration_id, checksum')) return { rows };
      if (normalized.startsWith('INSERT INTO mesh_schema_migrations')) {
        rows.push({ migration_id: params[0], checksum: params[1] });
      }
      if (failSql && normalized === failSql) throw new Error('simulated migration failure');
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  return { calls, rows, connect: async () => client };
}

test('migration IDs are stable, unique and SQL is non-empty', () => {
  assert.doesNotThrow(() => validateMigrations([{ id: '001_create_table', sql: 'SELECT 1' }]));
  assert.throws(() => validateMigrations([{ id: 'bad id', sql: 'SELECT 1' }]));
  assert.throws(() => validateMigrations([{ id: '001_same', sql: 'SELECT 1' }, { id: '001_same', sql: 'SELECT 2' }]));
  assert.throws(() => validateMigrations([{ id: '001_empty', sql: '  ' }]));
});

test('migration checksum is deterministic and changes when SQL changes', () => {
  assert.equal(migrationChecksum('SELECT 1'), migrationChecksum('SELECT 1'));
  assert.notEqual(migrationChecksum('SELECT 1'), migrationChecksum('SELECT 2'));
});

test('runner records a migration only after its SQL succeeds and commits', async () => {
  const pool = fakePool();
  await runMigrations(pool, [{ id: '001_create_table', sql: 'CREATE TABLE example(id INT)' }]);
  const sql = pool.calls.map(call => call.sql);
  assert.ok(sql.indexOf('BEGIN') < sql.indexOf('CREATE TABLE example(id INT)'));
  assert.ok(sql.indexOf('CREATE TABLE example(id INT)') < sql.findIndex(x => x.startsWith('INSERT INTO mesh_schema_migrations')));
  assert.ok(sql.indexOf('COMMIT') > sql.findIndex(x => x.startsWith('INSERT INTO mesh_schema_migrations')));
  assert.ok(sql.includes('SELECT pg_advisory_unlock($1, $2)'));
  assert.ok(sql.includes('RELEASE'));
});

test('runner skips an already applied migration with the same checksum', async () => {
  const sqlText = 'CREATE TABLE example(id INT)';
  const pool = fakePool({ applied: [{ migration_id: '001_create_table', checksum: migrationChecksum(sqlText) }] });
  await runMigrations(pool, [{ id: '001_create_table', sql: sqlText }]);
  assert.equal(pool.calls.filter(call => call.sql === sqlText).length, 0);
});

test('runner rejects edited SQL for an already applied migration', async () => {
  const pool = fakePool({ applied: [{ migration_id: '001_create_table', checksum: migrationChecksum('SELECT 1') }] });
  await assert.rejects(
    runMigrations(pool, [{ id: '001_create_table', sql: 'SELECT 2' }]),
    /checksum mismatch/
  );
  assert.ok(pool.calls.some(call => call.sql === 'SELECT pg_advisory_unlock($1, $2)'));
  assert.ok(pool.calls.some(call => call.sql === 'RELEASE'));
});

test('failed migration rolls back and is not recorded', async () => {
  const pool = fakePool({ failSql: 'CREATE TABLE broken(id INT)' });
  await assert.rejects(runMigrations(pool, [{ id: '001_broken', sql: 'CREATE TABLE broken(id INT)' }]), /simulated migration failure/);
  const sql = pool.calls.map(call => call.sql);
  assert.ok(sql.includes('ROLLBACK'));
  assert.equal(sql.some(x => x.startsWith('INSERT INTO mesh_schema_migrations')), false);
});
