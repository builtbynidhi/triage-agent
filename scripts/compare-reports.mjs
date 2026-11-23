// node scripts/compare-reports.mjs <main report.json> <branch report.json>
// Per-case pass rate before vs after, what flipped, and a plain merge verdict.
import { readFileSync } from "node:fs";

const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, "utf8")));

function byCase(report) {
  const m = new Map();
  for (const x of report.runs) {
    const e = m.get(x.caseId) ?? { pass: 0, n: 0, reasons: new Set() };
    if (x.complete) {
      e.n++;
      if (x.grade.pass) e.pass++;
      else x.grade.reasons.forEach((r) => e.reasons.add(r));
    }
    m.set(x.caseId, e);
  }
  return m;
}
const A = byCase(a);
const B = byCase(b);
const fmt = (e) => (e && e.n ? `${e.pass}/${e.n}` : "—");
const rows = { improved: [], regressed: [], "still failing": [] };
for (const id of [...new Set([...A.keys(), ...B.keys()])].sort()) {
  const x = A.get(id);
  const y = B.get(id);
  const was = x?.n ? x.pass / x.n : null;
  const now = y?.n ? y.pass / y.n : null;
  const line = `${id.padEnd(40)} ${fmt(x).padStart(4)} → ${fmt(y).padEnd(4)}${y?.reasons.size ? " [" + [...y.reasons].join("; ") + "]" : ""}`;
  if (was === null || now === null) continue;
  if (now > was) rows.improved.push(line);
  else if (now < was) rows.regressed.push(line);
  else if (now < 1) rows["still failing"].push(line);
}
for (const [k, v] of Object.entries(rows)) if (v.length) console.log(`\n## ${k} (${v.length})\n${v.join("\n")}`);

const sa = a.scorecard;
const sb = b.scorecard;
const pct = (r) => (r.of ? `${r.n}/${r.of} (${(100 * r.n / r.of).toFixed(1)}%)` : "n/a");
console.log("\n## scorecard (main → branch)");
console.log(`overall      ${pct(sa.passRate)} → ${pct(sb.passRate)}`);
for (const g of ["normal", "edge", "adversarial"]) console.log(`${g.padEnd(12)} ${pct(sa.byGroup[g])} → ${pct(sb.byGroup[g])}`);
console.log(`incomplete   ${sa.runs.incomplete} → ${sb.runs.incomplete}`);

const better = sb.passRate.rate > sa.passRate.rate;
const advOk = sb.byGroup.adversarial.rate >= sa.byGroup.adversarial.rate;
const complete = sb.runs.incomplete === 0;
console.log(
  `\nverdict: ${better && advOk && complete ? "MERGE-ABLE: pass rate improved, adversarial did not regress, no incomplete runs" : "DO NOT MERGE: " + [!better && "pass rate did not improve", !advOk && "adversarial regressed", !complete && "incomplete runs remain"].filter(Boolean).join("; ")}`,
);
