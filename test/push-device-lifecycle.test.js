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

test('push-device deletion endpoint scopes removal to the authenticated recipient and token', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(server, /DELETE FROM mesh_push_devices WHERE device_token=\$1 AND recipient_type=\$2 AND recipient_id=\$3/);
});
