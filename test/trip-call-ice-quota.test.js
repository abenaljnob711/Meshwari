'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const start = source.indexOf("app.post('/api/trips/:tripId/calls/:callId/ice'");
const end = source.indexOf("\napp.", start + 10);
const route = source.slice(start, end);

test('ICE candidate quota check and insert are serialized by locking the active call row', () => {
  assert.ok(start >= 0, 'ICE candidate route exists');
  assert.match(route, /await client\.query\('BEGIN'\)/);
  assert.match(route, /FOR UPDATE OF c, t/);
  assert.match(route, /SELECT COUNT\(\*\)::int AS total FROM mesh_trip_call_ice WHERE call_id=\$1 AND sender_id=\$2/);
  assert.match(route, /count\.rows\[0\]\.total >= 200/);
  assert.match(route, /INSERT INTO mesh_trip_call_ice/);
  assert.match(route, /await client\.query\('COMMIT'\)/);
  assert.ok(route.indexOf('FOR UPDATE OF c, t') < route.indexOf('SELECT COUNT'));
  assert.ok(route.indexOf('SELECT COUNT') < route.indexOf('INSERT INTO mesh_trip_call_ice'));
});

test('ICE quota rejection rolls back and always releases its database client', () => {
  assert.match(route, /await client\.query\('ROLLBACK'\);\s*return res\.status\(429\)/);
  assert.match(route, /catch \(error\) \{\s*await client\.query\('ROLLBACK'\)/);
  assert.match(route, /finally \{\s*client\.release\(\)/);
});
