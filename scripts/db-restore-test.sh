#!/usr/bin/env bash
set -euo pipefail
: "${BACKUP_FILE:?Set BACKUP_FILE to an encrypted .dump.gz.age backup}"
: "${BACKUP_AGE_IDENTITY:?Set BACKUP_AGE_IDENTITY to the path of the age identity file}"
: "${RESTORE_TEST_DATABASE_URL:?Set RESTORE_TEST_DATABASE_URL to a disposable, isolated test database}"
: "${RESTORE_TEST_CONFIRM:?Set RESTORE_TEST_CONFIRM to the exact safety phrase}"
if [ "$RESTORE_TEST_CONFIRM" != "I_UNDERSTAND_THIS_DESTROYS_TEST_DATABASE" ]; then echo "Restore safety confirmation did not match; refusing to continue." >&2; exit 1; fi

# Require a PostgreSQL URI whose database name explicitly ends in _test or _restore.
# Compare it with DATABASE_URL when supplied to prevent targeting the configured app DB.
node - "$RESTORE_TEST_DATABASE_URL" "${DATABASE_URL:-}" <<'NODE'
const [targetRaw, productionRaw] = process.argv.slice(2);
function parse(raw, label) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(label + ' must be a PostgreSQL URI'); }
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw new Error(label + ' must use postgres:// or postgresql://');
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!/(?:_test|_restore)$/i.test(database)) {
    throw new Error(label + ' database name must end with _test or _restore');
  }
  const host = u.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
    throw new Error(label + ' must point to local PostgreSQL for destructive restore tests');
  }
  return { host, port: u.port || '5432', database };
}
const target = parse(targetRaw, 'RESTORE_TEST_DATABASE_URL');
if (productionRaw) {
  let production;
  try { production = new URL(productionRaw); } catch { throw new Error('DATABASE_URL is not a valid PostgreSQL URI'); }
  const productionDb = decodeURIComponent(production.pathname.replace(/^\//, ''));
  if (target.host === production.hostname.toLowerCase() &&
      target.port === (production.port || '5432') &&
      target.database === productionDb) {
    throw new Error('Restore target matches DATABASE_URL; refusing destructive restore');
  }
}
NODE
command -v age >/dev/null || { echo "age is required" >&2; exit 1; }
command -v gzip >/dev/null || { echo "gzip is required" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore is required" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
test -s "$BACKUP_FILE"
test -s "$BACKUP_FILE.sha256" || { echo "Backup SHA-256 file is required; refusing restore." >&2; exit 1; }
(cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$BACKUP_FILE").sha256")
echo "Restoring only to the explicitly supplied disposable test database."
age -d -i "$BACKUP_AGE_IDENTITY" "$BACKUP_FILE" | gzip -dc | pg_restore --exit-on-error --no-owner --no-acl --clean --if-exists --dbname "$RESTORE_TEST_DATABASE_URL"
psql "$RESTORE_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT current_database(), COUNT(*) FROM information_schema.tables WHERE table_schema='public';"
echo "Restore test completed. Verify application-level row counts and login/booking flows before considering recovery successful."
