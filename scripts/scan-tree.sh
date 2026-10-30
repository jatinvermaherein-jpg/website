#!/usr/bin/env bash
# Law 4.5 — leave the tree clean: no caches, artifacts, binaries, secrets,
# or workspace/ inside a build context. A plan that leaks into an image is a
# plan published on the internet. Positive reporting per law 5.5.
#
# B4 — this gate now tests what it advertises: the build context must exclude
# workspace/ and .env via .dockerignore. The old version scanned four dirs
# for three patterns and never once looked at the folder it named in its
# own header.
set -euo pipefail
cd "$(dirname "$0")/.."

# What each check looks at. env-secrets excludes .github: workflow YAML
# legitimately carries dev-service URLs (not secrets), and the literal-mask
# check below is the one that polices the workflows.
SCAN_DIRS=(apps prisma netlify scripts .github)
ENV_SCAN_DIRS=(apps prisma netlify scripts)

FAIL=0
check() {
  local label="$1"; shift
  local hits
  # grep exits 1 on zero matches — under pipefail that would kill the script
  # (set -e) exactly when the tree is CLEAN, so wrap it: clean must pass.
  # NOTE: do NOT add a global --exclude here — GNU grep 3.11 silently drops
  # ALL --include filters when any --exclude is present (verified: 526 fake
  # hits). Per-check excludes go in "$@" only on checks without --include.
  hits=$( { grep -rn --exclude-dir=node_modules --exclude-dir=.pgdata --exclude-dir=dist "$@" "${SCAN_DIRS[@]}" 2>/dev/null || true; } | wc -l | tr -d ' ')
  if [ "$hits" != "0" ]; then
    echo "FAIL tree-scan:${label} (${hits})"
    grep -rn --exclude-dir=node_modules --exclude-dir=.pgdata --exclude-dir=dist "$@" "${SCAN_DIRS[@]}" 2>/dev/null | head -5
    FAIL=1
  fi
}

# binary-ish artifacts in source trees (one --include per extension —
# multiple --include flags on GNU grep 3.11 disable the filter entirely)
for ext in pyc so exe bin; do
  check "binary .$ext" --include="*.$ext"
done
# caches (this gate names the pattern itself, so exclude itself — safe here
# because this check has no --include)
check pycache -r '__pycache__' --exclude='scan-tree.sh'
# .env values committed (key=SECRET-ish patterns in source, excluding .env.example)
# — .github is out of scope: workflow YAML legitimately carries dev-service
# URLs, and the literal-mask check below polices the workflows.
SCAN_DIRS=("${ENV_SCAN_DIRS[@]}")
check env-secrets -E '(MASTER_KEY|JWT_SECRET|ADMIN_PASSWORD|DATABASE_URL)\s*=\s*[^ ]{8,}' --exclude='.env.example' --exclude='.gitignore'
SCAN_DIRS=("${SRC_DIRS[@]}")
# a literal mask in workflow YAML — the "***" that killed the first CI run (B2)
for ext in yml yaml; do
  check "literal-mask .$ext" --include="*.$ext" '\*\*\*'
done

# build context: .dockerignore must exist and exclude the plan and the secrets
if [ ! -f .dockerignore ]; then
  echo "FAIL tree-scan:build-context (.dockerignore missing — the plan ships in the image)"
  FAIL=1
elif ! grep -q '^workspace/' .dockerignore; then
  echo "FAIL tree-scan:build-context (.dockerignore does not exclude workspace/)"
  FAIL=1
elif ! grep -q '^\.env$' .dockerignore; then
  echo "FAIL tree-scan:build-context (.dockerignore does not exclude .env)"
  FAIL=1
else
  echo "PASS tree-scan:build-context workspace/ and .env excluded $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

if [ "$FAIL" != "0" ]; then exit 1; fi
echo "PASS tree-scan 0 violations $(date -u +%Y-%m-%dT%H:%M:%SZ)"
