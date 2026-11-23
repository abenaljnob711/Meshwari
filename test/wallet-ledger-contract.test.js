'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const schemaStart = server.indexOf('CREATE TABLE IF NOT EXISTS mesh_driver_wallet_transactions');
const schemaEnd = server.indexOf('CREATE TABLE IF NOT EXISTS mesh_otp_requests', schemaStart);
const walletSchema = server.slice(schemaStart, schemaEnd);
const adjustmentStart = server.indexOf("app.post('/api/admin/drivers/:id/wallet-adjustment'");
const adjustmentEnd = server.indexOf('/* Driver submits a replacement vehicle.', adjustmentStart);
const adjustmentRoute = server.slice(adjustmentStart, adjustmentEnd);

test('wallet ledger retains unique references and signed non-zero entries', () => {
  assert.notEqual(schemaStart, -1, 'wallet ledger table exists');
  assert.match(walletSchema, /amount NUMERIC\(12,2\) NOT NULL CHECK \(amount <> 0\)/);
  assert.match(walletSchema, /reference_key VARCHAR\(160\) UNIQUE/);
  assert.match(walletSchema, /balance_after NUMERIC\(12,2\) NOT NULL/);
});

test('legacy non-zero wallet balances are imported once as opening entries', () => {
  assert.match(walletSchema, /'opening:'\|\|d\.account_id/);
  assert.match(walletSchema, /WHERE d\.wallet_balance<>0 AND NOT EXISTS/);
  assert.match(walletSchema, /w\.reference_key='opening:'\|\|d\.account_id/);
});

test('admin wallet adjustment updates balance and inserts its ledger entry in one transaction', () => {
  assert.notEqual(adjustmentStart, -1, 'admin wallet adjustment route exists');
  const beginAt = adjustmentRoute.indexOf("await client.query('BEGIN')");
  const balanceAt = adjustmentRoute.indexOf('UPDATE mesh_driver_profiles d SET wallet_balance=d.wallet_balance+$1');
  const ledgerAt = adjustmentRoute.indexOf('INSERT INTO mesh_driver_wallet_transactions');
  const commitAt = adjustmentRoute.indexOf("await client.query('COMMIT')");
  assert.ok(beginAt >= 0 && balanceAt > beginAt && ledgerAt > balanceAt && commitAt > ledgerAt);
  assert.match(adjustmentRoute, /await client\.query\('ROLLBACK'\)/);
});

test('admin adjustment records the resulting wallet balance and actor', () => {
  assert.match(adjustmentRoute, /RETURNING d\.wallet_balance,d\.withdrawable_balance/);
  assert.match(adjustmentRoute, /\(driver_id,amount,balance_after,transaction_type,description,created_by\)/);
  assert.match(adjustmentRoute, /'admin_adjustment'/);
});


test('wallet adjustment writes its audit event before commit in the same transaction', () => {
  assert.match(adjustmentRoute, /INSERT INTO mesh_audit_logs \(actor_id, action, target_id, details\)/);
  const ledgerAt = adjustmentRoute.indexOf('INSERT INTO mesh_driver_wallet_transactions');
  const auditAt = adjustmentRoute.indexOf('INSERT INTO mesh_audit_logs');
  const commitAt = adjustmentRoute.indexOf("await client.query('COMMIT')");
  assert.ok(ledgerAt >= 0 && auditAt > ledgerAt && commitAt > auditAt);
  assert.doesNotMatch(adjustmentRoute, /await audit\(adminActorId\(req\),'driver_wallet_adjustment'/);
});

test('admin wallet adjustment requires a request idempotency key and stores it on the ledger entry', () => {
  assert.match(adjustmentRoute, /req\.get\('Idempotency-Key'\)/);
  assert.match(adjustmentRoute, /applyAdminWalletAdjustment\(pool/);
  assert.match(adjustmentRoute, /referenceKey:requestKey/);
  assert.match(adjustmentRoute, /Idempotency-Key/);
});
