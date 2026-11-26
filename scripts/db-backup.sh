#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_AGE_RECIPIENT:?Set BACKUP_AGE_RECIPIENT to the age public recipient}"
command -v pg_dump >/dev/null || { echo "pg_dump is required" >&2; exit 1; }
command -v age >/dev/null || { echo "age is required" >&2; exit 1; }
command -v gzip >/dev/null || { echo "gzip is required" >&2; exit 1; }
umask 077
OUT_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/meshwari-$STAMP.dump.gz.age"
TMP="$OUT.tmp"
trap 'rm -f "$TMP"' EXIT
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" | gzip -9 | age -r "$BACKUP_AGE_RECIPIENT" -o "$TMP"
test -s "$TMP"
mv "$TMP" "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
echo "Encrypted backup created: $OUT"
