'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Pool } = require('pg');
const { runMigrations } = require('../lib/migrations');

const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const schema = fs.readFileSync(require.resolve('../lib/schema-migrations.js'), 'utf8');
const app = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');

test('passenger and driver JWTs carry a positive account token version', () => {
  assert.match(server, /const signToken = \(sub, accountRole, tokenVersion = 1\)/);
  assert.match(server, /\{ sub: String\(sub\), role: accountRole, ver: Number\(tokenVersion\) \}/);
  assert.match(server, /token: signToken\(account\.id, account\.role, account\.token_version\)/);
});

test('passenger and driver authentication rejects revoked versions while preserving pre-migration tokens', () => {
  assert.match(server, /decoded\.ver === undefined \? 1 : Number\(decoded\.ver\)/);
  assert.match(server, /req\.user = \{ \.\.\.decoded, ver: tokenVersion \}/);
  assert.match(server, /Number\.isSafeInteger\(tokenVersion\)/);
  assert.match(server, /token_version = \$3/);
});

test('server logout increments the account token version and audits atomically', () => {
  const start = server.indexOf("app.post('/api/auth/logout'");
  const end = server.indexOf('/* Current account */', start);
  assert.ok(start >= 0 && end > start, 'logout endpoint must exist before /api/me');
  const route = server.slice(start, end);
  assert.match(route, /token_version = token_version \+ 1/);
  assert.ok(route.indexOf("INSERT INTO mesh_audit_logs") < route.indexOf("COMMIT"));
  assert.match(route, /ROLLBACK/);
});

test('client logout asks the server to revoke its current token', () => {
  assert.match(app, /api\('\/auth\/logout',\{\},'POST'\)/);
});

test('account token version is added through a versioned database migration', () => {
  assert.match(schema, /id: '003_account_session_revocation'/);
  assert.match(schema, /ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1/);
});
test('account lifecycle, trash restore, anonymization and approval changes revoke existing tokens', () => {
  assert.match(server, /deleted_at=NOW\(\),deleted_reason=\$2,token_version=token_version\+1/);
  assert.match(server, /deleted_at=NULL,deleted_reason=NULL,token_version=token_version\+1/);
  assert.match(server, /lifecycle_state = 'suspended',[\s\S]{0,180}token_version = token_version \+ 1/);
  assert.match(server, /lifecycle_state = 'open',[\s\S]{0,220}token_version = token_version \+ 1/);
  assert.match(server, /lifecycle_state = 'closed',[\s\S]{0,180}token_version = token_version \+ 1/);
  assert.match(server, /lifecycle_state = 'anonymized',[\s\S]{0,240}token_version = token_version \+ 1/);
  assert.match(server, /role = 'driver' RETURNING id, status/);
  assert.match(server, /role = 'passenger' RETURNING id, status/);
});

test('account session migration initializes existing accounts and enforces positive versions in PostgreSQL', {
  skip: !process.env.MIGRATIONS_TEST_DATABASE_URL && 'MIGRATIONS_TEST_DATABASE_URL is not configured'
}, async () => {
  const adminPool = new Pool({ connectionString: process.env.MIGRATIONS_TEST_DATABASE_URL, max: 1 });
  const schemaName = 'account_session_test_' + process.pid + '_' + Date.now();
  const quotedSchema = '"' + schemaName.replace(/"/g, '""') + '"';
  let scopedPool;
  try {
    await adminPool.query('CREATE SCHEMA ' + quotedSchema);
    scopedPool = new Pool({
      connectionString: process.env.MIGRATIONS_TEST_DATABASE_URL,
      max: 1,
      options: '-c search_path=' + schemaName + ',public'
    });
    await scopedPool.query('CREATE TABLE mesh_accounts (id BIGSERIAL PRIMARY KEY)');
    await scopedPool.query('INSERT INTO mesh_accounts DEFAULT VALUES');
    const migration = require('../lib/schema-migrations').migrations
      .filter(item => item.id === '003_account_session_revocation');
    assert.equal(migration.length, 1);
    await runMigrations(scopedPool, migration);
    await runMigrations(scopedPool, migration);
    const result = await scopedPool.query('SELECT token_version FROM mesh_accounts');
    assert.equal(result.rows[0].token_version, 1);
    await assert.rejects(
      scopedPool.query('UPDATE mesh_accounts SET token_version=0'),
      /check constraint/
    );
  } finally {
    if (scopedPool) await scopedPool.end();
    await adminPool.query('DROP SCHEMA IF EXISTS ' + quotedSchema + ' CASCADE');
    await adminPool.end();
  }
});

test('administrator logout revokes owner or delegated-manager token versions', () => {
  const start = server.indexOf("app.post('/api/admin/logout'");
  const end = server.indexOf('/* Administration login */', start);
  assert.ok(start >= 0 && end > start, 'admin logout endpoint must exist');
  const route = server.slice(start, end);
  assert.match(route, /mesh_admin_auth SET token_version = token_version \+ 1/);
  assert.match(route, /mesh_admin_users SET token_version = token_version \+ 1/);
  assert.match(route, /INSERT INTO mesh_audit_logs/);
  assert.ok(route.indexOf('INSERT INTO mesh_audit_logs') < route.indexOf('COMMIT'));
});

test('admin dashboard sends server-side logout before clearing its session token', () => {
  const admin = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');
  assert.match(admin, /api\('\/admin\/logout',\{\},'POST'\)/);
});
