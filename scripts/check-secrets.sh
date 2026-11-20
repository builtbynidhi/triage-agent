#!/usr/bin/env bash
# Pre-commit scan: fail if staged changes look like they contain an API key or secret.
set -euo pipefail
patterns='AIza[0-9A-Za-z_-]{35}|gsk_[0-9A-Za-z]{20,}|sk-[0-9A-Za-z]{20,}|ghp_[0-9A-Za-z]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(API_KEY|SECRET|TOKEN|PASSWORD)[A-Z_]*=[^[:space:]#]{8,}'
if git diff --cached --name-only | grep -Eq '(^|/)\.env$'; then
  echo "check-secrets: refusing to commit a .env file" >&2; exit 1
fi
if git diff --cached -U0 -- . ':!scripts/check-secrets.sh' ':!.env.example' | grep -E '^\+' | grep -Ev '^\+\+\+' | grep -Eq "$patterns"; then
  echo "check-secrets: possible secret in staged changes. Remove it (and rotate it if it was ever pushed)." >&2; exit 1
fi
