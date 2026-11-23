'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  migrationChecksum,
  validateMigrations,
  runMigrations
} = require('../lib/migrations');
const { migrations: schemaMigrations } = require('../lib/schema-migrations');

function fakePool({ appliedRows = [], failOnSql = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).trim().replace(/\s+/g, ' ');
      calls.push({ sql: normalized, params });
      if (normalized.startsWith('SELECT migration_id, checksum')) return { rows: appliedRows };
      if (failOnSql && normalized.includes(failOnSql)) throw new Error('simulated database failure');
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); }
  };
  return { calls, pool: { async connect() { return client; } } };
}

test('migration checksum is stable and changes with SQL', () => {
  assert.equal(migrationChecksum('SELECT 1'), migrationChecksum('SELECT 1'));
  assert.notEqual(migrationChecksum('SELECT 1'), migrationChecksum('SELECT 2'));
  assert.match(migrationChecksum('SELECT 1'), /^[a-f0-9]{64}$/);
});

test('migration validation rejects malformed and duplicate migrations', () => {
  assert.throws(() => validateMigrations(null), /array/);
  assert.throws(() => validateMigrations([{ id: 'bad', sql: 'SELECT 1' }]), /stable id/);
  assert.throws(() => validateMigrations([{ id: '001_valid', sql: ' ' }]), /stable id/);
  assert.throws(() => validateMigrations([
    { id: '001_duplicate', sql: 'SELECT 1' },
    { id: '001_duplicate', sql: 'SELECT 2' }
  ]), /Duplicate migration id/);
});

test('migration runner applies a migration and records its checksum transactionally', async () => {
  const { pool, calls } = fakePool();
  await runMigrations(pool, [{ id: '001_test_migration', sql: 'SELECT 42' }]);
  const statements = calls.map(call => call.sql);
  assert.ok(statements.some(sql => sql.startsWith('SELECT pg_advisory_lock')));
  assert.ok(statements.includes('BEGIN'));
  assert.ok(statements.includes('SELECT 42'));
  assert.ok(statements.some(sql => sql.startsWith('INSERT INTO mesh_schema_migrations')));
  assert.ok(statements.includes('COMMIT'));
  assert.ok(statements.some(sql => sql.startsWith('SELECT pg_advisory_unlock')));
  assert.equal(statements.at(-1), 'RELEASE');
});

test('migration runner skips an already applied migration with matching checksum', async () => {
  const migration = { id: '001_existing', sql: 'SELECT 7' };
  const { pool, calls } = fakePool({
    appliedRows: [{ migration_id: migration.id, checksum: migrationChecksum(migration.sql) }]
  });
  await runMigrations(pool, [migration]);
  const statements = calls.map(call => call.sql);
  assert.equal(statements.includes('SELECT 7'), false);
  assert.equal(statements.includes('BEGIN'), false);
  assert.ok(statements.some(sql => sql.startsWith('SELECT pg_advisory_unlock')));
});

test('migration runner rejects changed SQL for an applied migration', async () => {
  const migration = { id: '001_existing', sql: 'SELECT 8' };
  const { pool, calls } = fakePool({
    appliedRows: [{ migration_id: migration.id, checksum: migrationChecksum('SELECT 7') }]
  });
  await assert.rejects(runMigrations(pool, [migration]), /checksum mismatch/);
  assert.ok(calls.some(call => call.sql.startsWith('SELECT pg_advisory_unlock')));
  assert.equal(calls.at(-1).sql, 'RELEASE');
});

test('migration runner rolls back a failed migration and releases its lock', async () => {
  const { pool, calls } = fakePool({ failOnSql: 'BROKEN SQL' });
  await assert.rejects(
    runMigrations(pool, [{ id: '001_failure', sql: 'BROKEN SQL' }]),
    /simulated database failure/
  );
  const statements = calls.map(call => call.sql);
  assert.ok(statements.includes('ROLLBACK'));
  assert.ok(statements.some(sql => sql.startsWith('SELECT pg_advisory_unlock')));
  assert.equal(statements.at(-1), 'RELEASE');
});

test('active trip migration defines unique indexes for drivers and passengers', () => {
  const migration = schemaMigrations.find(item => item.id === '004_active_trip_uniqueness');
  assert.ok(migration);
  assert.match(migration.sql, /mesh_trips_one_active_driver_idx/);
  assert.match(migration.sql, /mesh_trips_one_active_passenger_idx/);
  assert.match(migration.sql, /'requested','accepted','arrived','in_progress'/);
  assert.match(migration.sql, /RAISE EXCEPTION/);
});
