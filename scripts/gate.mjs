// The CI gate and the nightly divergence check. See evals/src/gate.ts for the rules.
//
//   node scripts/gate.mjs                       compare evals/report/report.json with evals/baseline.json
//   node scripts/gate.mjs --diverge <report>    compare a live (nightly) report with the recordings
//
// Both print a markdown summary (used as the pull request comment and the nightly issue body) and
// exit 1 on failure or divergence, 2 on bad input.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { divergence, evaluateGate, renderDivergence, renderGate } from "../evals/src/gate.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    report: { type: "string", default: join(root, "evals", "report", "report.json") },
    baseline: { type: "string", default: join(root, "evals", "baseline.json") },
    diverge: { type: "string" },
    summary: { type: "string" },
  },
});

const read = (file, what) => {
  if (!existsSync(file)) {
    console.error(`gate: no ${what} at ${file}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(file, "utf8"));
};

const baseline = read(values.baseline, "baseline");
let markdown;
let failed;
if (values.diverge) {
  const d = divergence(read(values.diverge, "live report").runs, baseline);
  markdown = renderDivergence(d);
  failed = d.diverged.length > 0;
} else {
  const g = evaluateGate(read(values.report, "report").runs, baseline);
  markdown = renderGate(g);
  failed = !g.ok;
}
console.log(markdown);
if (values.summary) writeFileSync(values.summary, markdown + "\n");
process.exit(failed ? 1 : 0);
