/**
 * pnpm triage-failures [--report path]
 *
 * Prints the failing eval cases from the last scorecard, grouped by REASON, biggest group first:
 * grouping is what turns six failures into two fixes. Cases that could not be scored at all are
 * listed separately (not recorded, judge missing), since they are not failures of the agent.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface ReportRun {
  caseId: string;
  repeat: number;
  complete: boolean;
  incompleteReason?: string;
  grade?: { pass: boolean; reasons: string[] };
}

export interface FailureGroups {
  failing: { reason: string; cases: string[] }[];
  unscored: { reason: string; cases: string[] }[];
  failingCases: number;
}

export function groupFailures(runs: ReportRun[]): FailureGroups {
  const bucket = (pairs: [string, string][]) => {
    const m = new Map<string, Set<string>>();
    for (const [reason, id] of pairs) m.set(reason, (m.get(reason) ?? new Set()).add(id));
    return [...m.entries()]
      .map(([reason, ids]) => ({ reason, cases: [...ids].sort() }))
      .sort((a, b) => b.cases.length - a.cases.length || a.reason.localeCompare(b.reason));
  };
  const failed = runs.filter((r) => r.complete && r.grade && !r.grade.pass);
  return {
    failing: bucket(
      failed.flatMap((r) => r.grade!.reasons.map((x): [string, string] => [x, r.caseId])),
    ),
    unscored: bucket(
      runs
        .filter((r) => !r.complete)
        .map((r): [string, string] => [r.incompleteReason ?? "incomplete", r.caseId]),
    ),
    failingCases: new Set(failed.map((r) => r.caseId)).size,
  };
}

export function renderFailureGroups(g: FailureGroups): string {
  const lines: string[] = [];
  lines.push(
    `${g.failingCases} failing case${g.failingCases === 1 ? "" : "s"}, ${g.failing.length} cause${g.failing.length === 1 ? "" : "s"}`,
  );
  for (const f of g.failing)
    lines.push(
      `\n  ${f.reason}  (${f.cases.length})\n${f.cases.map((c) => `    - ${c}`).join("\n")}`,
    );
  if (g.unscored.length) {
    lines.push("\nNot scored (not agent failures):");
    for (const u of g.unscored)
      lines.push(`  ${u.reason}  (${u.cases.length}): ${u.cases.join(", ")}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseArgs({
    options: { report: { type: "string", default: join(root, "report", "report.json") } },
  });
  const report = JSON.parse(readFileSync(values.report!, "utf8")) as { runs: ReportRun[] };
  console.log(renderFailureGroups(groupFailures(report.runs)));
}
