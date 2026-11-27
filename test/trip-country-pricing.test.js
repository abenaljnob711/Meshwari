'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = server.indexOf("app.post('/api/pretrip-chats/:id/convert'");
const end = server.indexOf("app.delete('/api/pretrip-chats/:id'", start);
const route = server.slice(start, end);
const routeService = fs.readFileSync(path.join(__dirname, '../lib/route-distance.js'), 'utf8');

test('trip creation loads enabled country currency and fare settings from the database', () => {
  assert.ok(start >= 0 && end > start);
  assert.match(route, /FROM mesh_service_countries WHERE country_code=\$1 AND enabled=TRUE FOR SHARE/);
  assert.match(route, /pricing\.base_fare===null\|\|pricing\.per_km_rate===null/);
  assert.match(route, /تغير إعداد العملة أو التسعيرة منذ الاتفاق/);
  assert.match(route, /currency_code/);
  assert.match(route, /currency_minor_unit/);
});

test('trip creation stores immutable country currency and fare snapshots', () => {
  assert.match(route, /currency_code,currency_minor_unit_snapshot,base_fare_snapshot,per_km_rate_snapshot,commission_rate_snapshot/);
  assert.match(route, /calculateTripFinancialSnapshot\(/);
  assert.match(route, /pricing\.base_fare/);
  assert.match(route, /pricing\.per_km_rate/);
  assert.match(route, /financial\.commissionAmount/);
  assert.match(route, /financial\.driverNetAmount/);
  assert.doesNotMatch(route, /mesh_settings WHERE setting_key IN \('base_fare','per_km_rate'\)/);
});

test('trip fare uses route-provider distance and never a fabricated pickup-distance estimate', () => {
  assert.match(route, /getDrivingDistanceKm\(/);
  assert.match(route, /distance=await getDrivingDistanceKm\(/);
  assert.doesNotMatch(route, /pickupDistance|Math\.max\(1,Math\.ceil\(pickupDistance/);
  assert.match(routeService, /ROUTING_PROVIDER_NOT_CONFIGURED/);
  assert.match(route, /process\.env\.GOOGLE_MAPS_API_KEY/);
});
