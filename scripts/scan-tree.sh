#!/usr/bin/env bash
# Law 4.5 — leave the tree clean: no caches, artifacts, binaries, secrets,
# or workspace/ inside a build context. A plan that leaks into an image is a
# plan published on the internet. Positive reporting per law 5.5.
set -euo pipefail
cd "$(dirname "$0")/.."

FAIL=0
check() {
  local label="$1"; shift
  local hits
  hits=$(grep -rn --exclude-dir=node_modules --exclude-dir=.pgdata --exclude-dir=dist "$@" apps packages prisma deploy 2>/dev/null | wc -l | tr -d ' ')
  if [ "$hits" != "0" ]; then
    echo "FAIL tree-scan:${label} (${hits})"
    grep -rn --exclude-dir=node_modules --exclude-dir=.pgdata --exclude-dir=dist "$@" apps packages prisma deploy 2>/dev/null | head -5
    FAIL=1
  fi
}

# binary-ish artifacts in source trees
check binaries --include='*.pyc' --include='*.so' --include='*.exe' --include='*.bin' .
# caches
check pycache -r '__pycache__'
# .env values committed (key=SECRET-ish patterns in source, excluding .env.example)
check env-secrets -E '(MASTER_KEY|JWT_SECRET|ADMIN_PASSWORD|DATABASE_URL)\s*=\s*[^ ]{8,}' --exclude='.env.example' --exclude='.gitignore'

if [ "$FAIL" != "0" ]; then exit 1; fi
echo "PASS tree-scan 0 violations $(date -u +%Y-%m-%dT%H:%M:%SZ)"
