#!/usr/bin/env bash
# Resume the Phase 8b recording (see docs/failures.md). Safe to run at any time, as often as you like:
#   - records only cases that have no recording yet (record-missing); a recorded case is never re-spent
#   - uses Groq only, and stops by itself at the free-tier cap (the usage ledger is shared with the
#     main checkout, so work there cannot double-spend the same daily quota)
#   - commits and pushes new recordings to the branch (authored by your git user, no AI trailer)
#   - when all 40 cases are recorded, replays 3 repeats (0 API calls) and writes a comparison with main
# It never merges anything. Groq's daily quota resets at 00:00 UTC (05:30 IST).
set -euo pipefail
cd "$(dirname "$0")/.."
log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

[ "$(git branch --show-current)" = "phase-8-v2" ] || { log "run this from the phase-8-v2 checkout"; exit 1; }

# Absolute: `pnpm --filter` runs the eval from the evals/ folder, so a relative --out would land there.
OUT="$PWD/.cache/phase8b"
mkdir -p "$OUT"
# One run at a time (a second trigger while one is running just exits).
mkdir "$OUT/lock" 2>/dev/null || { log "another run is in progress (remove $OUT/lock if it crashed)"; exit 0; }
trap 'rmdir "$OUT/lock"' EXIT

# How many of the 40 cases have a recording? A replay costs no API calls.
recorded() {
  pnpm -s eval --repeats 1 --out "$OUT/count" >/dev/null 2>&1 || true
  node -e "const r=require('$OUT/count/report.json').scorecard.runs; console.log(r.complete)"
}

done_n=$(recorded)
log "recorded: $done_n of 40"

if [ "$done_n" -lt 40 ]; then
  used=$(node -e "
    try { const u = require('./.cache/usage/' + new Date().toISOString().slice(0,10) + '.json'); console.log(u.tokens.groq || 0) }
    catch { console.log(0) }")
  # A case costs about 8,000 tokens; do not start with less than one case of room under the 180k cap.
  if [ "$used" -ge 171000 ]; then
    log "Groq tokens used today (UTC): $used of the 180000 cap. Next run after 05:30 IST."
    exit 0
  fi
  log "recording (Groq only, $used tokens used today); it stops at the cap by itself"
  pnpm -s eval --mode record-missing --repeats 1 --out "$OUT/record" > "$OUT/record.log" 2>&1 || true
  grep -E '^  [a-z0-9-]+ #1: (PASS|FAIL)' "$OUT/record.log" | sed 's/^ *//' | cut -c1-110 || true
  done_after=$(recorded)
  log "recorded: $done_after of 40"
  if git status --short evals/cassettes | grep -q .; then
    bash scripts/check-secrets.sh
    if grep -lE "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[a-z]{2,}" evals/cassettes/*.json | grep -q .; then
      log "an e-mail address appears in a cassette: not committing"; exit 1
    fi
    git add evals/cassettes
    git commit -q -m "test(evals): record more v2 cases ($done_after of 40)

Phase 8b, resumable recording on Groq within the free tier."
    git push -q origin phase-8-v2
    log "committed and pushed"
  fi
  [ "$done_after" -lt 40 ] && { log "not finished: run again after the next 05:30 IST reset"; exit 0; }
fi

log "all 40 recorded: replaying 3 repeats (0 API calls) and comparing with main"
pnpm -s eval --repeats 3 --out "$OUT/final" > "$OUT/final.log" 2>&1 || true
git show main:evals/report/report.json > "$OUT/main-report.json"
node scripts/compare-reports.mjs "$OUT/main-report.json" "$OUT/final/report.json" | tee "$OUT/compare.txt"
log "done. Nothing was merged. Read $OUT/compare.txt, then decide."
