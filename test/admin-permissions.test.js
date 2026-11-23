'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { adminPermissionForRequest } = require('../lib/admin-permissions');

test('delegated admin permissions match the actual /api route paths and methods', () => {
  assert.equal(adminPermissionForRequest({ path: '/api/admin/whatsapp/settings', method: 'GET' }), 'manage_whatsapp_settings');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/whatsapp/settings', method: 'PUT' }), 'manage_whatsapp_settings');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/whatsapp/test', method: 'POST' }), 'manage_whatsapp_settings');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/accounts', method: 'GET' }), 'issue_otp');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/otp-eligible-accounts', method: 'GET' }), 'issue_otp');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/accounts/123/issue-code', method: 'POST' }), 'issue_otp');
});

test('delegated admin permissions deny unrelated paths and wrong methods by default', () => {
  assert.equal(adminPermissionForRequest({ path: '/api/admin/accounts', method: 'DELETE' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/accounts/123/issue-code', method: 'GET' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/drivers/123/wallet-adjustment', method: 'POST' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/trips/123/payment', method: 'PATCH' }), '__owner_only__');
  assert.equal(adminPermissionForRequest({ path: '/api/admin/me', method: 'GET' }), null);
});
