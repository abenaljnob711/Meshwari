'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const start = source.indexOf("/* Verify one-time login code */");
const end = source.indexOf("/* Current account */", start);
const route = source.slice(start, end);

test('successful OTP login writes its audit record before committing the same transaction', () => {
  const consume = route.indexOf("UPDATE mesh_otp_requests SET used_at = NOW()");
  const audit = route.indexOf("INSERT INTO mesh_audit_logs");
  const commit = route.indexOf("COMMIT", audit);
  assert.ok(consume >= 0, 'OTP must be consumed');
  assert.ok(audit > consume, 'audit must follow OTP consumption');
  assert.ok(commit > audit, 'audit must be committed with OTP consumption');
  assert.equal(route.includes("await audit(account.id, 'login'"), false,
    'login audit must not run after commit in a separate transaction');
});

test('invalid OTP attempts are persisted and capped for each OTP record', () => {
  assert.match(route, /otp\.attempts >= 5/);
  assert.match(route, /UPDATE mesh_otp_requests SET attempts = attempts \+ 1 WHERE id = \$1/);
  assert.match(route, /used_at IS NULL/);
});
