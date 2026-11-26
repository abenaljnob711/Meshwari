# Meshwari production acceptance gate

This checklist is the release gate for the three separate applications. A source review, a green unit-test run, or an APK build alone does not certify production readiness.

## 1. Source and diagnostic checks
- [ ] Run the repository test suite with `npm test` on Node.js 22, including `test/production-source-contract.test.js`.
- [ ] Run JavaScript syntax checks for `server.js`, all `lib/*.js`, and the inline scripts in `public/index.html` and `public/admin.html`.
- [ ] Apply the complete migration set to a disposable PostgreSQL database and rerun it to prove repeatability.
- [ ] Confirm the admin-only endpoints `/api/admin/production-readiness` and `/api/admin/wallets/reconciliation` return 401/403 to non-admin users and no-store responses to admins.
- [ ] Review every diagnostic result; configuration presence is not proof of provider reachability.

## 2. Database and financial integrity (isolated database only)
- [ ] Create a fresh disposable PostgreSQL database from the same major version as production.
- [ ] Apply all schema migrations; rerun them; verify no migration checksum drift.
- [ ] Seed synthetic passenger, driver, country, trip, wallet and ledger rows. Never copy production PII into an unsecured test database.
- [ ] Complete a cash trip and verify exactly one commission debt ledger entry and one matching currency-wallet transaction.
- [ ] Replay the same completion and verify no duplicate financial movement.
- [ ] Collect part of a driver's cash commission debt; verify the selected currency balance changes exactly, another currency remains unchanged, over-collection is rejected, and the audit event exists.
- [ ] Test admin adjustments, duplicate idempotency keys, rollback on failure, and concurrent collection attempts.
- [ ] Reconcile each driver/currency account against its ledger. Investigate every mismatch; do not assign a currency to legacy UNKNOWN movements by guessing.
- [ ] Verify trip reports and wallet reports against seeded source rows and export totals.

## 3. Three APKs on real Android devices
Test the exact release-signed APK artifacts, not a browser preview:
- [ ] Passenger: install, register/login, OTP, location permission, request/cancel trip, accept/complete lifecycle, chat, call, push notification, logout.
- [ ] Driver: install, register/login, approval state, online/offline, receive/accept/reject trip, foreground GPS notification, background tracking, route samples, chat/call, push, logout.
- [ ] Admin: install/login, owner/delegated permissions, account and trip operations, reports, wallet collection/adjustment, CSV export, clipboard/OTP functions; verify no Firebase push code is packaged.
- [ ] Verify package IDs and app labels: `com.meshwari.app`, `com.meshwari.driver`, `com.meshwari.admin`.
- [ ] Verify all APKs use the same permanent release certificate and that a subsequent version upgrades in place.
- [ ] Test Android 12, 13, and 14+ permission flows where supported; test denied permissions, battery optimization, app backgrounding, network loss, force-stop and device reboot.
- [ ] Verify push delivery on physical devices and tap-through navigation. A valid service-account JSON alone is not a delivery test.
- [ ] Verify calls on Wi-Fi and mobile networks, including restrictive NAT, with TURN relay actually selected.

## 4. Payment and settlement (no live charges until provider certification)
- [ ] Select a licensed payment provider for each launch country and obtain its official integration documentation and merchant account.
- [ ] Implement provider create-payment/authorization, signed webhook verification, idempotency, status reconciliation, refunds/reversals, timeout handling and settlement reports.
- [ ] Keep electronic payment disabled for a country until sandbox and provider certification tests pass.
- [ ] Test successful, declined, pending, duplicate webhook, forged webhook, timeout, refund, partial refund and reversal cases in provider sandbox.
- [ ] Verify gross fare, platform commission, driver net, currency precision and provider fees against immutable trip snapshots. Keep electronic trips blocked until provider integration exists and passes the sandbox matrix.
- [ ] Verify cash remains the Yemen default and electronic payment is enabled there only by the explicit country admin switch after provider certification.
- [ ] Verify countries outside Yemen support cash and electronic methods according to country policy, independent of a driver's personal bank card.
- [ ] Reconcile provider settlement statements to payment events and trip financial ledger before enabling live payments.

## 5. Encrypted backup and restore drill
- [ ] Choose an approved off-host backup destination and retention policy (daily, weekly, monthly); never keep the only backup beside the database.
- [ ] Create and protect an age private identity offline; store only the public recipient in the backup environment.
- [ ] Run `bash scripts/db-backup.sh` with `DATABASE_URL`, `BACKUP_AGE_RECIPIENT`, and a protected `BACKUP_DIR`.
- [ ] Verify the generated SHA-256 checksum and copy the encrypted file to the independent backup destination.
- [ ] Restore only into a new disposable database using `scripts/db-restore-test.sh`; never point `RESTORE_TEST_DATABASE_URL` at production.
- [ ] Run `bash scripts/db-verify-restore.sh` against the disposable restored database; verify account/trip counts, wallet balances by currency, ledger totals, migration records, and historical UNKNOWN movements. Investigate all mismatches.
- [ ] Record backup time, restore duration, verification results, operator, RPO and RTO. Repeat the restore drill at least monthly.

## Release decision
The release gate stays BLOCKED while any required item above is unchecked, any unexplained wallet mismatch exists, a payment provider is uncertified, or backup restoration has not been demonstrated. Record test evidence and date for each completed item. Do not convert untested configuration checks into a readiness percentage.
