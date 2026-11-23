'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const start = source.indexOf("app.patch('/api/trips/:tripId/calls/:callId/heartbeat'");
const end = source.indexOf("\\napp.", start + 10);
const route = source.slice(start, end);

test('trip-call heartbeat cannot revive an expired accepted call', () => {
  assert.ok(start >= 0, 'heartbeat route exists');
  assert.match(route, /c\\.status='accepted'/);
  assert.match(route, /c\\.expires_at>NOW\\(\\)/);
  assert.match(route, /t\\.status IN \\('accepted','arrived','in_progress'\\)/);
  assert.match(route, /c\\.caller_id=\\$3 OR c\\.callee_id=\\$3/);
  assert.match(route, /if \\(!result\\.rowCount\\) return res\\.status\\(409\\)/);
});

test('heartbeat expiry guard is part of the atomic UPDATE predicate', () => {
  assert.match(route, /UPDATE mesh_trip_calls c SET expires_at=NOW\\(\\)\\+INTERVAL '90 seconds'/);
  assert.match(route, /WHERE c\\.id=\\$1 AND c\\.trip_id=\\$2 AND c\\.status='accepted' AND c\\.expires_at>NOW\\(\\)/);
});
