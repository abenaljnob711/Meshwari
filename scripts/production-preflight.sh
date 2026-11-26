#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "Refusing DATABASE_URL. Use a disposable MIGRATIONS_TEST_DATABASE_URL only." >&2
  exit 2
fi
echo "== Meshwari source preflight =="
node --version
npm --version
test -f package-lock.json || { echo "package-lock.json is missing" >&2; exit 2; }
test -d node_modules || { echo "Run npm ci first." >&2; exit 2; }
while IFS= read -r file; do node --check "$file"; done < <(find lib scripts mobile -type f -name '*.js' -print 2>/dev/null)
node --check server.js
while IFS= read -r file; do node --check "$file"; done < <(find test -type f -name '*.js' -print 2>/dev/null)
node <<'NODE'
const fs = require('node:fs');
for (const file of ['public/index.html', 'public/admin.html']) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  for (const [index, match] of scripts.entries()) if (match[1].trim()) {
    try { new Function(match[1]); } catch (error) {
      throw new Error(file + ' inline script #' + (index + 1) + ': ' + error.message);
    }
  }
}
console.log('Inline browser scripts parse successfully.');
NODE
if [[ -n "${MIGRATIONS_TEST_DATABASE_URL:-}" ]]; then
  case "$MIGRATIONS_TEST_DATABASE_URL" in *localhost*|*127.0.0.1*|*test*) ;; *)
    echo "Refusing database URL not clearly marked as isolated local/test." >&2; exit 2;; esac
  echo "PostgreSQL integration tests enabled against isolated test DB."
else
  echo "WARNING: PostgreSQL integration tests will be skipped without MIGRATIONS_TEST_DATABASE_URL."
fi
npm test
echo "Source preflight complete; this does not certify device, payment-provider, production DB, or backup-restore tests."
