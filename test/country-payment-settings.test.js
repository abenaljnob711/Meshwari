'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

test('admin country settings expose cash and electronic payment switches', () => {
  assert.match(server, /require\('\.\/trip-payment-policy'\)/);
  assert.match(server, /c\.cash_enabled, c\.electronic_enabled/);
  const start = server.indexOf("app.post('/api/admin/service-countries'");
  const end = server.indexOf("app.post('/api/admin/service-areas'", start);
  assert.ok(start >= 0 && end > start);
  const route = server.slice(start, end);
  assert.match(route, /resolveCountryPaymentPolicy\(/);
  assert.match(route, /cash_enabled,electronic_enabled/);
  assert.match(route, /cashEnabled/);
  assert.match(route, /electronicEnabled/);
});

test('admin payment settings preserve omitted legacy fields rather than silently overwriting them', () => {
  const start = server.indexOf("app.post('/api/admin/service-countries'");
  const end = server.indexOf("app.post('/api/admin/service-areas'", start);
  const route = server.slice(start, end);
  assert.match(route, /cash_enabled=COALESCE\(\$5,mesh_service_countries\.cash_enabled\)/);
  assert.match(route, /electronic_enabled=COALESCE\(\$6,mesh_service_countries\.electronic_enabled\)/);
});
