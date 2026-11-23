#!/usr/bin/env bash
# Record the judge's scores (Phase 9). Safe to run any time, as often as you like:
#   - finds the judged cases that have no judge recording yet (a replay costs no API calls)
#   - calls Gemini (the judge) once per such case, and stops at the cap of 18 calls a day
#   - the agent's own answers replay from their recordings: Groq is never called
# Gemini's real daily quota resets at 13:30 IST. DRY=1 only lists what is missing.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$PWD/.cache/judge"
mkdir -p "$OUT"

pnpm -s eval --repeats 1 --out "$OUT/count" >/dev/null 2>&1 || true
ids=$(node -e "
  const r = require('$OUT/count/report.json');
  const ids = [...new Set(r.runs.filter(x => !x.complete && /no judge recording/.test(x.incompleteReason || '')).map(x => x.caseId))].sort();
  console.log(ids.join(' '))")
if [ -z "$ids" ]; then echo "all judgements are recorded"; exit 0; fi
echo "judgements still to record: $(echo $ids | wc -w)"
[ "${DRY:-}" = "1" ] && { echo $ids | tr ' ' '\n'; exit 0; }

used() { node -e "try { console.log(require('./.cache/usage/' + new Date().toISOString().slice(0,10) + '.json').calls.gemini || 0) } catch { console.log(0) }"; }
for id in $ids; do
  if [ "$(used)" -ge 18 ]; then echo "Gemini cap reached ($(used) of 18 today): run again after 13:30 IST"; break; fi
  pnpm -s eval --mode record-missing --repeats 1 --case "$id" --out "$OUT/last" 2>&1 | grep -E "#1:" | sed 's/^ *//' | cut -c1-130 || true
done
