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
  const end = source.indexOf('\n// Delegated ripple', start);
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

test('push token is persisted when registered and restored after app restart', () => {
  assert.match(source, /let mwPushToken=localStorage\.getItem\('mw_push_token'\)\|\|null/);
  assert.match(source, /localStorage\.setItem\('mw_push_token',mwPushToken\)/);
});

test('logout keeps the cached push token when server-side device removal fails', () => {
  const start = source.indexOf('async function logout()');
  const end = source.indexOf('async function factoryReset()', start);
  const logout = source.slice(start, end);
  assert.match(logout, /let removed=false/);
  assert.match(logout, /if\(removed\)\{mwPushToken=null;localStorage\.removeItem\('mw_push_token'\)\}/);
  assert.ok(logout.indexOf("api('/notifications/devices'") < logout.indexOf("api('/auth/logout'"), 'device removal is attempted before revoking the session');
});

test('factory reset clears the cached push token only after server confirms removal', () => {
  const start = source.indexOf('async function factoryReset()');
  const end = source.indexOf('\n// Delegated ripple', start);
  const reset = source.slice(start, end);
  assert.ok(start >= 0 && end > start, 'factory reset handler exists');
  assert.match(reset, /let removed=false/);
  assert.match(reset, /if\(removed\)\{mwPushToken=null;localStorage\.removeItem\('mw_push_token'\)\}/);
});

test('driver app exposes a notification inbox with read acknowledgement', () => {
  assert.match(source, /id="driverNotifications"/);
  assert.match(source, /id="driverNotificationsPanel"/);
  assert.match(source, /api\('\/notifications',undefined,'GET'\)/);
  assert.match(source, /data-driver-notification-read/);
  assert.match(source, /api\('\/notifications\/'.*?'PATCH'\)/);
});

test('trip cancellation notification identifies the cancelling participant correctly', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(server, /cancelled: \{ title: 'تم إلغاء الرحلة', body: req\.user\.role === 'passenger' \? 'ألغيت طلب الرحلة\.' : 'ألغى السائق الرحلة\.' \}/);
});

test('server logs FCM delivery rejections instead of silently ignoring them', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(server, /else if \(!result\.sent\) console\.error\('Firebase push was not accepted:'/);
});


test('admin notifications are persisted for every active admin even without native push devices', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const start = server.indexOf('async function notifyAllAdmins(notification)');
  const end = server.indexOf('\n}', start) + 2;
  const notify = server.slice(start, end);
  assert.ok(start >= 0 && end > start, 'admin notification fan-out exists');
  assert.match(notify, /SELECT id FROM mesh_admin_users WHERE is_active=TRUE/);
  assert.match(notify, /'admin:'\+String\(row\.id\)/);
  assert.match(notify, /SELECT 1 FROM mesh_admin_auth WHERE id=1/);
  assert.match(notify, /saveAndSendNotification\(recipient, notification\)/);
  assert.doesNotMatch(notify, /FROM mesh_push_devices/);
});


test('trip lifecycle notifications are sent only to the other participant', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const start = server.indexOf("app.patch('/api/trips/:id/status'");
  const end = server.indexOf("\n}));", start) + 5;
  const route = server.slice(start, end);
  assert.ok(start >= 0 && end > start, 'trip status endpoint exists');
  assert.match(route, /const allowed=\{requested:\['accepted','cancelled'\],accepted:\['arrived','cancelled'\],arrived:\['in_progress','cancelled'\],in_progress:\['completed'\]\}/);
  assert.match(route, /const recipient = req\.user\.role === 'passenger'\s*\? \{ type: 'driver', id: String\(t\.driver_id\) \}\s*: \{ type: 'passenger', id: String\(t\.passenger_id\) \}/);
  assert.match(route, /type: 'trip_' \+ status/);
  assert.match(route, /data: \{ tripId: id, status, screen: 'trips' \}/);
});

test('trip lifecycle notification failures do not roll back a committed status change', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const start = server.indexOf("app.patch('/api/trips/:id/status'");
  const end = server.indexOf("\n}));", start) + 5;
  const route = server.slice(start, end);
  assert.ok(route.indexOf("await client.query('COMMIT')") < route.indexOf('await saveAndSendNotification(recipient'));
  assert.match(route, /catch \(error\) \{\s*console\.error\('Trip status notification failed:'/);
  assert.match(route, /res\.json\(\{ok:true,trip:updated\.rows\[0\]\}\)/);
});
