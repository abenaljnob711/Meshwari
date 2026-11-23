'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const routeStart = server.indexOf("app.post('/api/trips/:id/calls'");
const nextRoute = server.indexOf('\napp.', routeStart + 10);
const route = server.slice(routeStart, nextRoute < 0 ? undefined : nextRoute);

test('incoming trip-call push targets the other trip participant after call creation', () => {
  assert.notEqual(routeStart, -1, 'trip call route exists');
  const insertAt = route.indexOf('INSERT INTO mesh_trip_calls');
  const notifyAt = route.indexOf('await saveAndSendNotification(');
  assert.ok(insertAt >= 0, 'call row is inserted');
  assert.ok(notifyAt > insertAt, 'push is sent only after successful call insert');
  assert.match(route, /loadTripCallParticipant\(tripId, req\.user\.sub\)/);
  assert.match(route, /const calleeId = String\(trip\.passenger_id\) === String\(req\.user\.sub\) \? trip\.driver_id : trip\.passenger_id/);
  assert.match(route, /const recipientRole = String\(trip\.passenger_id\) === String\(calleeId\) \? 'passenger' : 'driver'/);
  assert.match(route, /type: 'trip_call'/);
  assert.match(route, /callId: String\(result\.rows\[0\]\.id\)/);
  assert.match(route, /screen: 'trips'/);
});

test('push delivery failure does not block the successful call-creation response', () => {
  const notifyAt = route.indexOf('await saveAndSendNotification(');
  const catchAt = route.indexOf("console.error('Trip call notification failed:'");
  const responseAt = route.indexOf('res.status(201).json({ ok: true, call })');
  assert.ok(notifyAt >= 0 && catchAt > notifyAt && responseAt > catchAt);
  assert.match(route, /catch \(error\) \{\s*console\.error\('Trip call notification failed:'/);
});
