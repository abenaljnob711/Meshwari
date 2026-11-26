'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const json = relative => JSON.parse(read(relative));

test('the three Android applications retain distinct stable package IDs and labels', () => {
  assert.equal(json('capacitor.config.json').appId, 'com.meshwari.app');
  assert.equal(json('capacitor.config.json').appName, 'مشواري - الراكب');
  assert.equal(json('capacitor.driver.config.json').appId, 'com.meshwari.driver');
  assert.equal(json('capacitor.driver.config.json').appName, 'مشواري - السائق');
  assert.equal(json('capacitor.admin.config.json').appId, 'com.meshwari.admin');
  assert.equal(json('capacitor.admin.config.json').appName, 'إدارة مشواري');
});

test('APK workflow is manually triggered and requires stable release signing', () => {
  const workflow = read('.github/workflows/build-apk.yml');
  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:\s*$/m);
  for (const name of ['ANDROID_KEYSTORE_BASE64','ANDROID_KEYSTORE_PASSWORD','ANDROID_KEY_ALIAS','ANDROID_KEY_PASSWORD']) {
    assert.ok(workflow.includes(name), 'Missing release signing secret: ' + name);
  }
  for (const apk of ['Meshwari-Passenger.apk','Meshwari-Driver.apk','Meshwari-Admin.apk']) {
    assert.ok(workflow.includes(apk), 'Missing APK artifact: ' + apk);
  }
  assert.equal((workflow.match(/assembleRelease/g) || []).length, 3);
});

test('driver native GPS service is connected to the authenticated API and foreground location service', () => {
  const service = read('mobile/driver-background/DriverLocationService.java');
  const plugin = read('mobile/driver-background/DriverLocationPlugin.java');
  const bridge = read('mobile/driver-background/driver-location-bridge.js');
  const workflow = read('.github/workflows/build-apk.yml');
  const server = read('server.js');
  assert.match(service, /startForeground\(NOTIFICATION_ID, notification, ServiceInfo\.FOREGROUND_SERVICE_TYPE_LOCATION\)/);
  assert.match(service, /setRequestMethod\("PUT"\)/);
  assert.match(service, /"\/driver\/location"/);
  assert.match(service, /Authorization", "Bearer " \+ bearer/);
  assert.match(plugin, /ACCESS_BACKGROUND_LOCATION/);
  assert.match(plugin, /@CapacitorPlugin\(name = "DriverLocation"\)/);
  assert.match(bridge, /registerPlugin\('DriverLocation'\)/);
  assert.match(workflow, /FOREGROUND_SERVICE_LOCATION/);
  assert.match(workflow, /DriverLocationPlugin\.class/);
  assert.match(server, /app\.put\('\/api\/driver\/location', auth, role\('driver'\)/);
});

test('admin APK remains isolated from native Firebase push integration', () => {
  const workflow = read('.github/workflows/build-apk.yml');
  assert.match(workflow, /Admin app must not contain native Firebase Push code/);
  assert.match(workflow, /clipboard-bundle\.js/);
  assert.match(workflow, /FIREBASE_GOOGLE_SERVICES_PASSENGER_BASE64/);
  assert.match(workflow, /FIREBASE_GOOGLE_SERVICES_DRIVER_BASE64/);
});

test('electronic trips are explicitly blocked until a provider integration is certified', () => {
  const server = read('server.js');
  assert.match(server, /ELECTRONIC_PAYMENT_PROVIDER_UNAVAILABLE/);
  assert.doesNotMatch(server, /app\.post\('\/api\/payments\/webhook'/);
});

test('backup and restore tooling requires encryption and a separately named restore-test database', () => {
  const backup = read('scripts/db-backup.sh');
  const restore = read('scripts/db-restore-test.sh');
  const verify = read('scripts/db-verify-restore.sh');
  const offsite = read('scripts/db-backup-offsite.sh');
  assert.match(backup, /BACKUP_AGE_RECIPIENT/);
  assert.match(backup, /age -r/);
  assert.match(offsite, /BACKUP_REMOTE_DESTINATION/);
  assert.match(offsite, /rclone check/);
  assert.match(offsite, /--download/);
  assert.match(restore, /RESTORE_TEST_DATABASE_URL/);
  assert.match(restore, /I_UNDERSTAND_THIS_DESTROYS_TEST_DATABASE/);
  assert.match(restore, /pg_restore --exit-on-error/);
  assert.match(verify, /database name must end in _test or _restore/);
  assert.match(verify, /Wallet balance and currency ledger mismatch found/);
});

test('wallet reconciliation includes both legacy balance fields and keeps unknown currency unresolved', () => {
  const server = read('server.js');
  const admin = read('public/admin.html');
  assert.match(server, /legacy_unclassified_balance/);
  assert.match(server, /legacy_unclassified_withdrawable_balance/);
  assert.match(server, /COALESCE\(withdrawable_balance,0\)<>0/);
  assert.match(server, /legacyUnclassified:legacyResult\.rows/);
  assert.match(admin, /legacy_unclassified_withdrawable_balance/);
  assert.match(admin, /عملة غير معروفة/);
  assert.match(admin, /needs_manual_review/);
});

test('PostgreSQL wallet integration tests cover concurrent collection, idempotency and currency isolation', () => {
  const integration = read('test/migrations-postgres.test.js');
  assert.match(integration, /Promise\.all\(\[\s*recordDriverCashCollection/);
  assert.match(integration, /Promise\.allSettled/);
  assert.match(integration, /replayedCollection\.replayed, true/);
  assert.match(integration, /currencyIsolation\.rows/);
  assert.match(integration, /EUR/);
  assert.match(integration, /USD/);
});

test('production readiness diagnostics fail closed when migrations or offsite backups are unverified', () => {
  const server = read('server.js');
  const admin = read('public/admin.html');
  assert.match(server, /app\.get\('\/api\/admin\/production-readiness'/);
  assert.match(server, /try\s*\{\s*const migrationResult=await pool\.query\('SELECT migration_id,checksum FROM mesh_schema_migrations'\)/);
  assert.match(server, /migrationChecksum\(item\.sql\)/);
  assert.match(server, /Applied migration checksum mismatch/);
  assert.match(server, /add\('wallet_reconciliation',walletReconciliationReady/);
  assert.match(server, /legacy_unclassified_accounts/);
  assert.match(server, /unknown_currency_movements/);
  assert.match(server, /currency_code IS NULL OR currency_code !~ '\\\^\\[A-Z\\]\\{3\\}\\
  assert.match(server, /wallet_balance IS NULL/);
  assert.match(server, /add\('offsite_backup_and_restore',false/);
  assert.match(server, /add\('electronic_payment_provider',false/);
  assert.match(server, /add\('device_acceptance_tests',false/);
  assert.match(admin, /async function loadProductionReadiness\(/);
  assert.doesNotMatch(admin, /async async function loadProductionReadiness/);
  assert.match(admin, /loadProductionReadiness\(\);/);
});

test('all production backup and restore shell scripts pass bash syntax validation', () => {
  for (const file of [
    'scripts/db-backup.sh',
    'scripts/db-backup-offsite.sh',
    'scripts/db-restore-test.sh',
    'scripts/db-verify-restore.sh',
    'scripts/production-preflight.sh'
  ]) {
    execFileSync('bash', ['-n', path.join(__dirname, '..', file)]);
  }
});

test('restore tooling requires a checksum and a database name ending in test or restore', () => {
  const restore = read('scripts/db-restore-test.sh');
  const verify = read('scripts/db-verify-restore.sh');
  const preflight = read('scripts/production-preflight.sh');
  assert.match(preflight, /Test database name must end in _test or _restore/);
  assert.match(restore, /_test\|_restore/);
  assert.match(restore, /database name must end with _test or _restore/);
  assert.match(restore, /test -s "\$BACKUP_FILE\.sha256"/);
  assert.match(restore, /sha256sum -c/);
  assert.match(restore, /target\.host === production\.hostname/);
  assert.match(verify, /database name must end in _test or _restore/);
});
/);
  assert.match(server, /COALESCE\\(wallet_balance,0\\)<>COALESCE\\(ledger_balance,0\\)/);
  assert.match(server, /wallet_balance IS NULL/);
  assert.match(server, /add\('offsite_backup_and_restore',false/);
  assert.match(server, /add\('electronic_payment_provider',false/);
  assert.match(server, /add\('device_acceptance_tests',false/);
  assert.match(admin, /async function loadProductionReadiness\(/);
  assert.doesNotMatch(admin, /async async function loadProductionReadiness/);
  assert.match(admin, /loadProductionReadiness\(\);/);
});

test('all production backup and restore shell scripts pass bash syntax validation', () => {
  for (const file of [
    'scripts/db-backup.sh',
    'scripts/db-backup-offsite.sh',
    'scripts/db-restore-test.sh',
    'scripts/db-verify-restore.sh',
    'scripts/production-preflight.sh'
  ]) {
    execFileSync('bash', ['-n', path.join(__dirname, '..', file)]);
  }
});

test('restore tooling requires a checksum and a database name ending in test or restore', () => {
  const restore = read('scripts/db-restore-test.sh');
  const verify = read('scripts/db-verify-restore.sh');
  const preflight = read('scripts/production-preflight.sh');
  assert.match(preflight, /Test database name must end in _test or _restore/);
  assert.match(restore, /_test\|_restore/);
  assert.match(restore, /database name must end with _test or _restore/);
  assert.match(restore, /test -s "\$BACKUP_FILE\.sha256"/);
  assert.match(restore, /sha256sum -c/);
  assert.match(restore, /target\.host === production\.hostname/);
  assert.match(verify, /database name must end in _test or _restore/);
});
