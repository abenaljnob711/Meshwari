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

test('commission policy defaults to free and accepts bounded optional percentages', () => {
  const { parseCommissionRate } = require('../lib/commission-policy');
  assert.equal(parseCommissionRate(undefined), null);
  assert.equal(parseCommissionRate('0'), 0);
  assert.equal(parseCommissionRate('12.5'), 12.5);
  assert.equal(parseCommissionRate('100'), 100);
  assert.throws(() => parseCommissionRate('-1'), /decimal/);
  assert.throws(() => parseCommissionRate('100.1'), /between 0 and 100/);
  assert.throws(() => parseCommissionRate('1.12345'), /decimal/);
  assert.throws(() => parseCommissionRate('1e2'), /decimal/);
  assert.throws(() => parseCommissionRate(''), /decimal/);
});

test('global free mode always resolves to zero and enabled mode uses the country rate', () => {
  const { resolveCommissionRate } = require('../lib/commission-policy');
  assert.equal(resolveCommissionRate(false, 15), 0);
  assert.equal(resolveCommissionRate(false, null), 0);
  assert.equal(resolveCommissionRate(true, null), 0);
  assert.equal(resolveCommissionRate(true, '7.5'), 7.5);
  assert.equal(resolveCommissionRate(true, 0), 0);
});


test('country pricing migration stores immutable per-trip price and commission snapshots', () => {
  const migration = schemaMigrations.find(item => item.id === '001_country_pricing_snapshots');
  assert.ok(migration);
  assert.match(migration.sql, /mesh_service_countries[\s\S]*currency_code CHAR\(3\)/);
  assert.match(migration.sql, /base_fare NUMERIC\(12,2\)/);
  assert.match(migration.sql, /per_km_rate NUMERIC\(12,2\)/);
  assert.match(migration.sql, /mesh_trips[\s\S]*country_code CHAR\(2\)/);
  assert.match(migration.sql, /commission_rate_snapshot NUMERIC\(7,4\)/);
});

test('trip financial foundation has idempotent ledger and payment-event references', () => {
  const migration = schemaMigrations.find(item => item.id === '002_trip_financial_foundation');
  assert.ok(migration);
  for (const entry of ['commission_debt','commission_collection','electronic_collection','driver_settlement','refund','reversal','adjustment']) {
    assert.ok(migration.sql.includes("'" + entry + "'"), 'missing ledger entry type ' + entry);
  }
  assert.match(migration.sql, /reference_key VARCHAR\(180\) NOT NULL UNIQUE/);
  assert.match(migration.sql, /UNIQUE\(provider,provider_event_id\)/);
  assert.match(migration.sql, /idempotency_key VARCHAR\(180\) NOT NULL UNIQUE/);
  assert.match(migration.sql, /commission_amount_snapshot NUMERIC\(12,2\)/);
  assert.match(migration.sql, /driver_net_amount_snapshot NUMERIC\(12,2\)/);
});
