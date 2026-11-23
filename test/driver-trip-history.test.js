'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

test('driver trip history is authenticated and restricted to the signed-in driver', () => {
  const start = server.indexOf("app.get('/api/driver/trips/history'");
  assert.notEqual(start, -1, 'driver history route exists');
  const end = server.indexOf('));', start);
  const route = server.slice(start, end + 3);
  assert.match(route, /auth,\s*role\('driver'\)/);
  assert.match(route, /WHERE t\.driver_id=\$1/);
  assert.match(route, /req\.user\.sub/);
  assert.match(route, /ORDER BY t\.created_at DESC,t\.id DESC LIMIT 50/);
  assert.match(route, /payment_status/);
});

test('driver app exposes a working trip-history control and calls its API', () => {
  assert.match(ui, /id="driverTripHistoryToggle"/);
  assert.match(ui, /id="driverTripHistory"/);
  assert.match(ui, /getElementById\('driverTripHistoryToggle'\)\.onclick\s*=\s*async/);
  assert.match(ui, /api\('\/driver\/trips\/history',undefined,'GET'\)/);
  assert.match(ui, /payment_status/);
});
