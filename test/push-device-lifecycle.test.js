'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');

test('factory reset removes the current push-device registration before clearing local account state', () => {
  const start = source.indexOf('async function factoryReset()');
  const end = source.indexOf('\n', start);
  const reset = source.slice(start, end);
  assert.ok(start >= 0, 'factory reset handler exists');
  assert.match(reset, /stopTripInteraction\(\)/);
  assert.match(reset, /api\('\/notifications\/devices',[\s\S]*?'DELETE'\)/);
  assert.match(reset, /MeshwariPushNotifications\?\.unregister\(\)/);
  assert.ok(reset.indexOf("api('/notifications/devices'") < reset.indexOf("token=''"),
    'server device removal is attempted before clearing the in-memory login token');
  assert.ok(reset.indexOf("api('/notifications/devices'") < reset.indexOf("for(const k of ['mw_token'"),
    'server device removal is attempted before clearing the persisted login token');
});

test('logout unregisters the native push token even when no registration event populated the in-memory token', () => {
  const start = source.indexOf('async function logout()');
  const end = source.indexOf('async function factoryReset()', start);
  const logout = source.slice(start, end);
  assert.ok(start >= 0 && end > start, 'logout handler exists');
  assert.match(logout, /if\(mwPushToken\)\{/);
  assert.match(logout, /\}try\{await window\.MeshwariPushNotifications\?\.unregister\(\)\}/);
});

test('factory reset unregisters native push independently of whether a token value is cached', () => {
  const start = source.indexOf('async function factoryReset()');
  const end = source.indexOf('\\n// Delegated ripple', start);
  const reset = source.slice(start, end);
  assert.ok(start >= 0, 'factory reset handler exists');
  assert.match(reset, /if\(mwPushToken\)\{/);
  assert.match(reset, /\}try\{await window\.MeshwariPushNotifications\?\.unregister\(\)\}/);
});

test('push-device deletion endpoint scopes removal to the authenticated recipient and token', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(server, /DELETE FROM mesh_push_devices WHERE device_token=\$1 AND recipient_type=\$2 AND recipient_id=\$3/);
});

test('registering a device after an account switch transfers the token to the authenticated account', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const start = server.indexOf("app.post('/api/notifications/devices'");
  const end = server.indexOf("app.delete('/api/notifications/devices'", start);
  const endpoint = server.slice(start, end);
  assert.ok(start >= 0 && end > start, 'authenticated device registration endpoint exists');
  assert.match(endpoint, /ON CONFLICT\(device_token\) DO UPDATE SET[\s\S]*recipient_type=EXCLUDED\.recipient_type[\s\S]*recipient_id=EXCLUDED\.recipient_id/);
  assert.match(endpoint, /const recipient=pushRecipient\(req\)/);
  assert.doesNotMatch(endpoint, /return res\.status\(409\)/);
});

test('health reports push configured only after validating the Firebase service-account JSON', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(server, /const \{ sendFirebasePush, loadServiceAccount \} = require\('\.\/lib\/firebase-push'\)/);
  assert.match(server, /firebaseConfigurationValid = Boolean\(loadServiceAccount\(\)\)/);
  assert.match(server, /pushNotificationsConfigured: firebaseConfigured && firebaseConfigurationValid/);
  assert.doesNotMatch(server, /pushNotificationsConfigured: Boolean\(process\.env\.FIREBASE_SERVICE_ACCOUNT_JSON\)/);
});
