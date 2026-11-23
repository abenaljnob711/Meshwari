'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const schema = fs.readFileSync(require.resolve('../lib/schema-migrations.js'), 'utf8');
const app = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');

test('passenger and driver JWTs carry a positive account token version', () => {
  assert.match(server, /const signToken = \(sub, accountRole, tokenVersion = 1\)/);
  assert.match(server, /\{ sub: String\(sub\), role: accountRole, ver: Number\(tokenVersion\) \}/);
  assert.match(server, /token: signToken\(account\.id, account\.role, account\.token_version\)/);
});

test('passenger and driver authentication rejects revoked or legacy tokens', () => {
  assert.match(server, /const tokenVersion = Number\(decoded\.ver\)/);
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
