#!/usr/bin/env bash
set -euo pipefail
: "${BACKUP_FILE:?Set BACKUP_FILE to an encrypted .dump.gz.age backup}"
: "${BACKUP_AGE_IDENTITY:?Set BACKUP_AGE_IDENTITY to the path of the age identity file}"
: "${RESTORE_TEST_DATABASE_URL:?Set RESTORE_TEST_DATABASE_URL to a disposable, isolated test database}"
: "${RESTORE_TEST_CONFIRM:?Set RESTORE_TEST_CONFIRM to the exact safety phrase}"
if [ "$RESTORE_TEST_CONFIRM" != "I_UNDERSTAND_THIS_DESTROYS_TEST_DATABASE" ]; then echo "Restore safety confirmation did not match; refusing to continue." >&2; exit 1; fi
command -v age >/dev/null || { echo "age is required" >&2; exit 1; }
command -v gzip >/dev/null || { echo "gzip is required" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore is required" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
test -s "$BACKUP_FILE"
if [ -f "$BACKUP_FILE.sha256" ]; then (cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$BACKUP_FILE").sha256"); fi
echo "Restoring only to the explicitly supplied disposable test database."
age -d -i "$BACKUP_AGE_IDENTITY" "$BACKUP_FILE" | gzip -dc | pg_restore --exit-on-error --no-owner --no-acl --clean --if-exists --dbname "$RESTORE_TEST_DATABASE_URL"
psql "$RESTORE_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT current_database(), COUNT(*) FROM information_schema.tables WHERE table_schema='public';"
echo "Restore test completed. Verify application-level row counts and login/booking flows before considering recovery successful."
