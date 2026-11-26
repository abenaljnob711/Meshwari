'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { canonicalDecimal } = require('../lib/wallet-adjustment');

test('wallet decimal normalization preserves four fractional digits without floating point', () => {
  assert.equal(canonicalDecimal('0012.3400'), '12.34');
  assert.equal(canonicalDecimal('-0.0000'), '0');
  assert.equal(canonicalDecimal('-0.0001'), '-0.0001');
  assert.equal(canonicalDecimal('0.12345'), null);
  assert.equal(canonicalDecimal('1e-4'), null);
});

test('admin wallet adjustments are scoped to the requested currency account', () => {
  const source = fs.readFileSync(require.resolve('../lib/wallet-adjustment'), 'utf8');
  assert.match(source, /INSERT INTO mesh_driver_wallet_accounts\(driver_id,currency_code,balance\)/);
  assert.match(source, /WHERE driver_id=\$1 AND currency_code=\$2/);
  assert.match(source, /currency_code\)\s*VALUES\(\$1,\$2,\$3/);
  assert.match(source, /String\(row\.currency_code \|\| ''\) === input\.currencyCode/);
  assert.doesNotMatch(source, /UPDATE mesh_driver_profiles SET wallet_balance/);
});

test('cash trip commission debt is written only to the trip currency wallet', () => {
  const source = fs.readFileSync(require.resolve('../lib/record-cash-trip-commission'), 'utf8');
  assert.match(source, /mesh_driver_wallet_accounts\(driver_id,currency_code,balance\)/);
  assert.match(source, /trip\.currency_code/);
  assert.match(source, /mesh_driver_wallet_transactions[\s\S]*currency_code/);
  assert.doesNotMatch(source, /UPDATE mesh_driver_profiles SET wallet_balance/);
});

test('currency wallet migration preserves legacy balances as unclassified historical amounts', () => {
  const migrations = fs.readFileSync(require.resolve('../lib/schema-migrations'), 'utf8');
  const server = fs.readFileSync(require.resolve('../server'), 'utf8');
  assert.match(migrations, /006_currency_scoped_driver_wallets/);
  assert.match(migrations, /ADD COLUMN currency_code CHAR\(3\)/);
  assert.match(migrations, /CREATE TABLE mesh_driver_wallet_accounts/);
  assert.match(migrations, /currency_code CHAR\(3\) NOT NULL CHECK \(currency_code ~ '\^\[A-Z\]\{3\}\
  assert.match(server, /legacy_currency_unknown:true/);
  assert.match(server, /SELECT DISTINCT currency_minor_unit FROM mesh_service_countries WHERE currency_code=\$1/);
});
\)/);
  assert.match(server, /legacy_currency_unknown:true/);
  assert.match(server, /SELECT DISTINCT currency_minor_unit FROM mesh_service_countries WHERE currency_code=\$1/);
});
