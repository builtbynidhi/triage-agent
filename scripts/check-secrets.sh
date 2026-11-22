#!/usr/bin/env bash
# Fail if anything looks like an API key or secret.
#   check-secrets.sh        scan staged changes (pre-commit hook)
#   check-secrets.sh --all  scan every tracked file (CI)
set -euo pipefail
patterns='AIza[0-9A-Za-z_-]{35}|gsk_[0-9A-Za-z]{20,}|sk-[0-9A-Za-z]{20,}|ghp_[0-9A-Za-z]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(API_KEY|SECRET|TOKEN|PASSWORD)[A-Z_]*=[^[:space:]#]{8,}'
exclude=(':!scripts/check-secrets.sh') # .env.example is scanned too: real keys once landed there by mistake

if [[ "${1:-}" == "--all" ]]; then
  if git ls-files | grep -Eq '(^|/)\.env$'; then
    echo "check-secrets: a .env file is tracked" >&2; exit 1
  fi
  if git grep -nIE "$patterns" -- . "${exclude[@]}"; then
    echo "check-secrets: possible secret in tracked files (above)." >&2; exit 1
  fi
  echo "check-secrets: no secrets found in tracked files"
  exit 0
fi

if git diff --cached --name-only | grep -Eq '(^|/)\.env$'; then
  echo "check-secrets: refusing to commit a .env file" >&2; exit 1
fi
if git diff --cached -U0 -- . "${exclude[@]}" | grep -E '^\+' | grep -Ev '^\+\+\+' | grep -Eq "$patterns"; then
  echo "check-secrets: possible secret in staged changes. Remove it (and rotate it if it was ever pushed)." >&2; exit 1
fi
