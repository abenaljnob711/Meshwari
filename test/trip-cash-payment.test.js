'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const start = server.indexOf("app.patch('/api/trips/:id/cash-payment'");
const end = server.indexOf('/* Private audio-call signaling for trip participants.', start);
const route = server.slice(start, end);

test('only the assigned driver can confirm cash for a completed cash trip', () => {
  assert.ok(start >= 0 && end > start);
  assert.match(route, /auth, role\('driver'\)/);
  assert.match(route, /WHERE id=\$1 AND driver_id=\$2 FOR UPDATE/);
  assert.match(route, /trip\.status!=='completed'\|\|trip\.payment_method!=='cash'/);
  assert.match(route, /payment_status='paid'/);
});

test('cash receipt confirmation is idempotent and audited', () => {
  assert.match(route, /if\(trip\.payment_status==='paid'\)/);
  assert.match(route, /driver_cash_payment_confirmed/);
  assert.match(route, /await client\.query\('COMMIT'\)/);
  assert.match(route, /await client\.query\('ROLLBACK'\)/);
});

test('driver UI exposes cash receipt confirmation only for unpaid completed cash trips', () => {
  assert.match(html, /trip\.status==='completed' && trip\.payment_method==='cash' && trip\.payment_status!=='paid'/);
  assert.match(html, /data-trip-cash-paid/);
  assert.match(html, /\/cash-payment/);
});
