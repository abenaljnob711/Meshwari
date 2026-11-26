'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const server = read('server.js');
const helper = read('lib/wallet-adjustment.js');
const collection = read('lib/wallet-collection.js');
const migrations = read('lib/schema-migrations.js');
const schemaStart = server.indexOf('CREATE TABLE IF NOT EXISTS mesh_driver_wallet_transactions');
const schemaEnd = server.indexOf('CREATE TABLE IF NOT EXISTS mesh_otp_requests', schemaStart);
const walletSchema = server.slice(schemaStart, schemaEnd);
const adjustmentStart = server.indexOf("app.post('/api/admin/drivers/:id/wallet-adjustment'");
const adjustmentEnd = server.indexOf("app.post('/api/admin/drivers/:id/wallet-collection'", adjustmentStart);
const adjustmentRoute = server.slice(adjustmentStart, adjustmentEnd);
const collectionStart = server.indexOf("app.post('/api/admin/drivers/:id/wallet-collection'");
const collectionEnd = server.indexOf('/* Driver submits a replacement vehicle.', collectionStart);
const collectionRoute = server.slice(collectionStart, collectionEnd);

test('wallet ledger retains unique references and signed non-zero entries', () => {
  assert.notEqual(schemaStart, -1, 'wallet ledger table exists');
  assert.match(walletSchema, /amount NUMERIC\(12,2\) NOT NULL CHECK \(amount <> 0\)/);
  assert.match(walletSchema, /reference_key VARCHAR\(160\) UNIQUE/);
  assert.match(walletSchema, /balance_after NUMERIC\(12,2\) NOT NULL/);
});

test('legacy non-zero wallet balances are imported once without inventing a currency', () => {
  assert.match(walletSchema, /'opening:'\|\|d\.account_id/);
  assert.match(walletSchema, /WHERE d\.wallet_balance<>0 AND NOT EXISTS/);
  assert.match(walletSchema, /w\.reference_key='opening:'\|\|d\.account_id/);
  const migration = migrations.slice(migrations.indexOf('006_currency_scoped_driver_wallets'));
  assert.match(migration, /ADD COLUMN currency_code CHAR\(3\)/);
  assert.match(migration, /CREATE TABLE mesh_driver_wallet_accounts/);
  assert.match(migration, /currency_code CHAR\(3\) NOT NULL/);
});

test('admin wallet adjustment changes only the selected currency wallet inside one transaction', () => {
  assert.notEqual(adjustmentStart, -1, 'admin wallet adjustment route exists');
  const beginAt = helper.indexOf("await client.query('BEGIN')");
  const balanceAt = helper.indexOf('UPDATE mesh_driver_wallet_accounts');
  const ledgerAt = helper.indexOf('INSERT INTO mesh_driver_wallet_transactions');
  const auditAt = helper.indexOf('INSERT INTO mesh_audit_logs');
  const commitAt = helper.lastIndexOf("await client.query('COMMIT')");
  assert.ok(beginAt >= 0 && balanceAt > beginAt && ledgerAt > balanceAt && auditAt > ledgerAt && commitAt > auditAt);
  assert.match(helper, /WHERE driver_id=\$1 AND currency_code=\$2/);
  assert.doesNotMatch(helper, /UPDATE mesh_driver_profiles/);
  assert.match(helper, /await client\.query\('ROLLBACK'\)/);
});

test('admin adjustment records currency, actor, unique reference and audit event', () => {
  assert.match(helper, /currency_code\)/);
  assert.match(helper, /'admin_adjustment'/);
  assert.match(helper, /input\.adminId/);
  assert.match(helper, /input\.auditActorId/);
  assert.match(helper, /const referenceKey = 'admin-adjustment:' \+ input\.requestKey/);
  assert.match(helper, /error\.code === '23505'/);
  assert.match(adjustmentRoute, /req\.get\('Idempotency-Key'\)/);
  assert.match(adjustmentRoute, /currency_code/);
  assert.match(adjustmentRoute, /applyAdminWalletAdjustment\(pool/);
});

test('cash collection is limited to outstanding debt in the same currency', () => {
  assert.match(collection, /balance < 0 AND \$3::numeric <= ABS\(balance\)/);
  assert.match(collection, /WHERE driver_id=\$1 AND currency_code=\$2/);
  assert.match(collection, /'cash_collection'/);
  assert.match(collection, /INSERT INTO mesh_audit_logs/);
  assert.match(collectionRoute, /recordDriverCashCollection\(pool/);
  assert.match(collectionRoute, /Idempotency-Key/);
  assert.match(collectionRoute, /currency_code/);
});

test('wallet reconciliation exposes unknown legacy balances instead of assigning a currency', () => {
  assert.match(server, /legacy_unclassified_balance/);
  assert.match(server, /legacy_unclassified_withdrawable_balance/);
  assert.match(server, /legacyUnclassified:legacyResult\.rows/);
  assert.match(server, /UNKNOWN يمثل حركات تاريخية/);
});
