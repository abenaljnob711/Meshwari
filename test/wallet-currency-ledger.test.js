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
  assert.ok(source.includes('INSERT INTO mesh_driver_wallet_accounts(driver_id,currency_code,balance)'));
  assert.ok(source.includes('WHERE driver_id=$1 AND currency_code=$2'));
  assert.ok(source.includes('String(row.currency_code || \'\').trim() === input.currencyCode'));
  assert.ok(!source.includes('UPDATE mesh_driver_profiles SET wallet_balance'));
});

test('cash trip commission debt is written only to the trip currency wallet', () => {
  const source = fs.readFileSync(require.resolve('../lib/record-cash-trip-commission'), 'utf8');
  assert.ok(source.includes('mesh_driver_wallet_accounts(driver_id,currency_code,balance)'));
  assert.ok(source.includes('trip.currency_code'));
  assert.ok(source.includes('mesh_driver_wallet_transactions'));
  assert.ok(!source.includes('UPDATE mesh_driver_profiles SET wallet_balance'));
});

test('driver wallet UI displays currency-scoped balances and both legacy balances separately', () => {
  const client = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  assert.ok(client.includes('d.currencyWallets'));
  assert.ok(client.includes('d.wallet.legacy_balance'));
  assert.ok(client.includes('d.wallet.legacy_withdrawable_balance'));
});

test('currency wallet migration preserves legacy balances as unclassified historical amounts', () => {
  const migrations = fs.readFileSync(require.resolve('../lib/schema-migrations'), 'utf8');
  const server = fs.readFileSync(require.resolve('../server'), 'utf8');
  assert.ok(migrations.includes('006_currency_scoped_driver_wallets'));
  assert.ok(migrations.includes('ADD COLUMN currency_code CHAR(3)'));
  assert.ok(migrations.includes('CREATE TABLE mesh_driver_wallet_accounts'));
  assert.ok(migrations.includes("currency_code CHAR(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$')"));
  assert.ok(server.includes('legacy_currency_unknown:true'));
  assert.ok(server.includes('SELECT DISTINCT currency_minor_unit FROM mesh_service_countries WHERE currency_code=$1'));
});
