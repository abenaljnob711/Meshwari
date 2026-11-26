#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${BACKUP_REMOTE_DESTINATION:?Set BACKUP_REMOTE_DESTINATION to an approved rclone remote path, e.g. remote:meshwari-backups}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
export BACKUP_DIR

command -v rclone >/dev/null || { echo "rclone is required for off-host backup transfer." >&2; exit 1; }

bash "$ROOT/scripts/db-backup.sh"

BACKUP_FILE="$(ls -1t "$BACKUP_DIR"/meshwari-*.dump.gz.age 2>/dev/null | head -n1)"
test -n "$BACKUP_FILE" && test -s "$BACKUP_FILE"
CHECKSUM_FILE="$BACKUP_FILE.sha256"
test -s "$CHECKSUM_FILE"

REMOTE="$BACKUP_REMOTE_DESTINATION/$(basename "$BACKUP_FILE")"
rclone copyto "$BACKUP_FILE" "$REMOTE"
rclone copyto "$CHECKSUM_FILE" "$REMOTE.sha256"

# Force a content comparison rather than trusting a successful upload response.
rclone check "$BACKUP_DIR" "$BACKUP_REMOTE_DESTINATION" --one-way --download \
  --include "$(basename "$BACKUP_FILE")" \
  --include "$(basename "$CHECKSUM_FILE")"

echo "Encrypted backup copied off-host and content-checked: $REMOTE"
