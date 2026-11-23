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
});

test('delegated permissions do not expose full account data or nonexistent routes', () => {
  assert.equal(adminPermissionForRequest({ path: '/api/admin/accounts', method: 'GET' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/whatsapp/test', method: 'POST' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/accounts', method: 'DELETE' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/accounts/123/issue-code', method: 'GET' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/drivers/123/wallet-adjustment', method: 'POST' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/trips/123/payment', method: 'PATCH' }), '__owner_only__');
});
