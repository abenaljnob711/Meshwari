'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { adminPermissionForRequest } = require('../lib/admin-permissions');

test('delegated permissions match the intended admin routes and methods', () => {
  assert.equal(adminPermissionForRequest({ path: '/api/admin/whatsapp/settings', method: 'GET' }), 'manage_whatsapp_settings');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/whatsapp/settings', method: 'PUT' }), 'manage_whatsapp_settings');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/otp-eligible-accounts', method: 'GET' }), 'issue_otp');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/accounts/123/issue-code', method: 'POST' }), 'issue_otp');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/me', method: 'GET' }), null);
  assert.equal(adminPermissionForRequest({ path: '/api/admin/logout', method: 'POST' }), null);
});

test('delegated permissions do not expose full account data or nonexistent routes', () => {
  assert.equal(adminPermissionForRequest({ path: '/api/admin/accounts', method: 'GET' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/whatsapp/test', method: 'POST' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/accounts', method: 'DELETE' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/accounts/123/issue-code', method: 'GET' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/drivers/123/wallet-adjustment', method: 'POST' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/trips/123/payment', method: 'PATCH' }), '__owner_only__');
});


const fs = require('node:fs');
const serverSource = fs.readFileSync(require.resolve('../server.js'), 'utf8');

test('admin OTP issuance is rate-limited and rejects inactive, closed or deleted accounts', () => {
  assert.match(serverSource, /const adminOtpIssueLimiter = rateLimit\(\{[\s\S]*?windowMs: 15 \* 60 \* 1000, limit: 5/);
  assert.match(serverSource, /app\.post\('\/api\/admin\/accounts\/:id\/issue-code', auth, adminOtpIssueLimiter, role\('admin'\)/);
  assert.match(serverSource, /SELECT id, role, status, phone, lifecycle_state, deleted_at FROM mesh_accounts WHERE id=\$1 FOR UPDATE/);
  assert.match(serverSource, /account\.status !== 'active' \|\| account\.lifecycle_state !== 'open' \|\| account\.deleted_at/);
});

test('OTP verification has an independent request rate limit in addition to per-code attempt checks', () => {
  assert.match(serverSource, /const otpVerifyLimiter = rateLimit\(\{[\s\S]*?windowMs: 15 \* 60 \* 1000, limit: 10/);
  assert.match(serverSource, /app\.post\('\/api\/auth\/verify-code', otpVerifyLimiter, asyncHandler/);
  assert.match(serverSource, /otp\.attempts >= 5/);
});
