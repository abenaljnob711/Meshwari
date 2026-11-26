#!/usr/bin/env bash
set -euo pipefail
: "${RESTORE_TEST_DATABASE_URL:?Set RESTORE_TEST_DATABASE_URL to a disposable restored test database}"
node - "$RESTORE_TEST_DATABASE_URL" "${DATABASE_URL:-}" <<'NODE'
const [targetRaw, productionRaw] = process.argv.slice(2);
function parse(raw, label) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(label + ' must be a PostgreSQL URI'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(label + ' must use PostgreSQL');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/(?:_test|_restore)$/i.test(database)) throw new Error(label + ' database name must end in _test or _restore');
  return {host:url.hostname.toLowerCase(),port:url.port||'5432',database};
}
const target=parse(targetRaw,'RESTORE_TEST_DATABASE_URL');
if (productionRaw) {
  let production;
  try { production = new URL(productionRaw); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URI'); }
  if (!['postgres:', 'postgresql:'].includes(production.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
  const productionDb = decodeURIComponent(production.pathname.replace(/^\\//, ''));
  if (target.host === production.hostname.toLowerCase() &&
      target.port === (production.port || '5432') &&
      target.database === productionDb) {
    throw new Error('Verification target matches DATABASE_URL; refusing to inspect production as a restore test');
  }
}
NODE
command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
psql "$RESTORE_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
\echo '== Restored database structural checks =='
DO $$
DECLARE missing text[];
BEGIN
  SELECT array_agg(name) INTO missing
  FROM (VALUES
    ('mesh_accounts'),('mesh_trips'),('mesh_schema_migrations'),
    ('mesh_driver_wallet_accounts'),('mesh_driver_wallet_transactions'),
    ('mesh_trip_financial_ledger'),('mesh_trip_payment_attempts'),
    ('mesh_payment_webhook_events'),('mesh_trip_location_samples'),
    ('mesh_audit_logs')
  ) required(name)
  WHERE to_regclass('public.' || name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Restore is missing required tables: %', array_to_string(missing, ', ');
  END IF;
END $$;

\echo '== Migration history =='
SELECT COUNT(*) AS applied_migrations,
       MAX(applied_at) AS latest_migration_at
FROM mesh_schema_migrations;

\echo '== Core record counts =='
SELECT 'accounts' AS entity, COUNT(*)::bigint AS row_count FROM mesh_accounts
UNION ALL SELECT 'trips', COUNT(*)::bigint FROM mesh_trips
UNION ALL SELECT 'wallet_accounts', COUNT(*)::bigint FROM mesh_driver_wallet_accounts
UNION ALL SELECT 'wallet_transactions', COUNT(*)::bigint FROM mesh_driver_wallet_transactions
UNION ALL SELECT 'trip_financial_ledger', COUNT(*)::bigint FROM mesh_trip_financial_ledger
UNION ALL SELECT 'payment_attempts', COUNT(*)::bigint FROM mesh_trip_payment_attempts
UNION ALL SELECT 'trip_location_samples', COUNT(*)::bigint FROM mesh_trip_location_samples
ORDER BY entity;

\echo '== Wallet ledger reconciliation exceptions (must be zero or investigated) =='
WITH movements AS (
  SELECT driver_id,currency_code,SUM(amount)::numeric(18,4) AS ledger_balance
  FROM mesh_driver_wallet_transactions
  WHERE currency_code IS NOT NULL
  GROUP BY driver_id,currency_code
)
SELECT w.driver_id,w.currency_code,w.balance AS wallet_balance,
       COALESCE(m.ledger_balance,0) AS ledger_balance,
       w.balance-COALESCE(m.ledger_balance,0) AS difference
FROM mesh_driver_wallet_accounts w
LEFT JOIN movements m USING(driver_id,currency_code)
WHERE w.balance<>COALESCE(m.ledger_balance,0)
ORDER BY w.currency_code,w.driver_id;

\echo '== Historical wallet movements with unknown currency (report, do not guess) =='
SELECT COUNT(*) AS unknown_currency_movement_count,
       COALESCE(SUM(amount),0)::numeric(18,4) AS unknown_currency_net
FROM mesh_driver_wallet_transactions
WHERE currency_code IS NULL;

\echo 'Restore verification queries completed. Review counts against the backup manifest and investigate every wallet mismatch.'
SQL
