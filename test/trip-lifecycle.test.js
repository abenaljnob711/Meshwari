'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const routeStart = server.indexOf("app.patch('/api/trips/:id/status'");
const routeEnd = server.indexOf('/* Private audio-call signaling for trip participants. ', routeStart);
const route = server.slice(routeStart, routeEnd === -1 ? undefined : routeEnd);

test('trip lifecycle is restricted to the trip participants and serialized', () => {
  assert.notEqual(routeStart, -1, 'trip status route exists');
  assert.match(route, /SELECT \* FROM mesh_trips WHERE id=\$1 AND \(passenger_id=\$2 OR driver_id=\$2\) FOR UPDATE/);
  assert.match(route, /await client\.query\('BEGIN'\)/);
  assert.match(route, /await client\.query\('COMMIT'\)/);
});

test('passenger can only cancel and driver cannot cancel through this route', () => {
  assert.match(route, /req\.user\.role==='driver'&&!driverStatuses\.includes\(status\)/);
  assert.match(route, /req\.user\.role==='passenger'&&status!=='cancelled'/);
  assert.match(route, /requested:\['accepted','cancelled'\]/);
  assert.match(route, /accepted:\['arrived','cancelled'\]/);
  assert.match(route, /arrived:\['in_progress','cancelled'\]/);
  assert.match(route, /in_progress:\['completed'\]/);
});

test('each lifecycle transition notifies the other participant after commit', () => {
  const commitAt = route.indexOf("await client.query('COMMIT')");
  const notifyAt = route.indexOf('await saveAndSendNotification(recipient');
  assert.ok(commitAt >= 0 && notifyAt > commitAt, 'push delivery happens after trip transaction commit');
  for (const status of ['accepted', 'arrived', 'in_progress', 'completed', 'cancelled']) {
    assert.ok(route.includes(status + ': { title:'), 'missing notification copy for ' + status);
  }
  assert.match(route, /req\.user\.role === 'passenger'[\s\S]*?\{ type: 'driver', id: String\(t\.driver_id\) \}/);
  assert.match(route, /\{ type: 'passenger', id: String\(t\.passenger_id\) \}/);
  assert.match(route, /type: 'trip_' \+ status/);
  assert.match(route, /tripId: id, status, screen: 'trips'/);
});

test('push delivery failure does not roll back a committed trip transition', () => {
  assert.match(route, /catch \(error\) \{\s*console\.error\('Trip status notification failed:'/);
  assert.match(route, /res\.json\(\{ok:true,trip:updated\.rows\[0\]\}\)/);
});
