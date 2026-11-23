'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const helper = fs.readFileSync(path.join(__dirname, '../lib/wallet-adjustment.js'), 'utf8');
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
  const beginAt = helper.indexOf("await client.query('BEGIN')");
  const balanceAt = helper.indexOf('UPDATE mesh_driver_profiles d SET wallet_balance=d.wallet_balance+$1');
  const ledgerAt = helper.indexOf('INSERT INTO mesh_driver_wallet_transactions');
  // The helper commits early only for an idempotent replay; inspect the final
  // commit to verify the new-adjustment path after its ledger and audit writes.
  const commitAt = helper.lastIndexOf("await client.query('COMMIT')");
  assert.ok(beginAt >= 0 && balanceAt > beginAt && ledgerAt > balanceAt && commitAt > ledgerAt);
  assert.match(helper, /await client\.query\('ROLLBACK'\)/);
});

test('admin adjustment records the resulting wallet balance and actor', () => {
  assert.match(helper, /RETURNING d\.wallet_balance,d\.withdrawable_balance/);
  assert.match(helper, /\(driver_id,amount,balance_after,transaction_type,description,reference_key,created_by\)/);
  assert.match(helper, /'admin_adjustment'/);
  assert.match(helper, /input\.adminId/);
});

test('wallet adjustment writes its audit event before commit in the same transaction', () => {
  assert.match(helper, /INSERT INTO mesh_audit_logs\s*\(actor_id,\s*action,\s*target_id,\s*details\)/);
  const ledgerAt = helper.indexOf('INSERT INTO mesh_driver_wallet_transactions');
  const auditAt = helper.indexOf('INSERT INTO mesh_audit_logs');
  const commitAt = helper.lastIndexOf("await client.query('COMMIT')");
  assert.ok(ledgerAt >= 0 && auditAt > ledgerAt && commitAt > auditAt);
  assert.match(helper, /input\.auditActorId/);
  assert.doesNotMatch(adjustmentRoute, /await audit\(adminActorId\(req\),'driver_wallet_adjustment'/);
});

test('admin wallet adjustment requires an idempotency key and persists it in the ledger reference', () => {
  assert.match(adjustmentRoute, /req\.get\('Idempotency-Key'\)/);
  assert.match(adjustmentRoute, /applyAdminWalletAdjustment\(pool/);
  assert.match(adjustmentRoute, /requestKey,adminId:req\.user\.sub/);
  assert.match(helper, /const referenceKey = 'admin-adjustment:' \+ input\.requestKey/);
  assert.match(helper, /WHERE reference_key=\$1/);
  assert.match(helper, /reference_key,created_by/);
  assert.match(helper, /error\.code === '23505'/);
});
