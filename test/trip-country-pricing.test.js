'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = server.indexOf("app.post('/api/trips'");
const end = server.indexOf("/* Passenger's current requested", start);
const route = server.slice(start, end);

test('trip creation loads enabled country currency and fare settings from the database', () => {
  assert.ok(start >= 0 && end > start);
  assert.match(route, /FROM mesh_service_countries WHERE country_code=\$1 AND enabled=TRUE FOR SHARE/);
  assert.match(route, /COUNTRY_PRICING_NOT_CONFIGURED/);
  assert.match(route, /currency_code/);
  assert.match(route, /currency_minor_unit/);
});

test('trip creation stores immutable country currency and fare snapshots', () => {
  assert.match(route, /currency_code,currency_minor_unit_snapshot,base_fare_snapshot,per_km_rate_snapshot,commission_rate_snapshot/);
  assert.match(route, /decimalToMinorUnits\(pricing\.base_fare, currencyMinorUnit/);
  assert.match(route, /decimalToMinorUnits\(pricing\.per_km_rate, currencyMinorUnit/);
  assert.match(route, /minorUnitsToDecimal\(baseFareMinor \+ variableFareMinor, currencyMinorUnit\)/);
  assert.doesNotMatch(route, /mesh_settings WHERE setting_key IN \('base_fare','per_km_rate'\)/);
});
