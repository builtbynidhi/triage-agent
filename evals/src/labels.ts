import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Ratio, ScoredRun } from "./metrics.ts";

/**
 * Hand labels for the judge check (spec: "label 15 replies yourself as pass or fail, run the judge
 * over the same 15, and report the agreement rate").
 *
 * A label says whether the owner would accept the reply against its rubric: "pass" (would send it,
 * a 3 or better) or "fail". The sheet the owner labels never shows the judge's score, so the labels
 * are independent of it. Agreement is the share of labelled replies where the judge's pass/fail
 * equals the label.
 */
export interface Label {
  item: number;
  case_id: string;
  label: "pass" | "fail" | "";
  note?: string;
}

export const LABELS_FILE = "judge-labels.yaml";
/** An AI second reviewer's labels: same shape, reported separately, never called hand labels. */
export const AI_LABELS_FILE = "judge-labels.ai.yaml";

export function loadLabels(file: string): Label[] {
  if (!existsSync(file)) return [];
  const doc = parse(readFileSync(file, "utf8")) as { labels?: Label[] } | null;
  return (doc?.labels ?? []).filter((l) => l.label === "pass" || l.label === "fail");
}

export interface Agreement extends Ratio {
  disagreements: { case_id: string; label: string; judge: string }[];
  /** Labelled replies that had no judge score yet (not recorded), so were not counted. */
  unjudged: number;
}

/** Judge pass/fail vs the owner's labels, on the first repeat of each labelled case. */
export function agreement(labels: Label[], runs: ScoredRun[]): Agreement | null {
  if (!labels.length) return null;
  let n = 0;
  let of = 0;
  let unjudged = 0;
  const disagreements: Agreement["disagreements"] = [];
  for (const l of labels) {
    const run = runs.find((r) => r.caseId === l.case_id && r.repeat === 1 && r.complete);
    const j = run?.grade?.judge;
    if (!j || typeof j === "string") {
      unjudged++;
      continue;
    }
    of++;
    if ((l.label === "pass") === j.pass) n++;
    else
      disagreements.push({
        case_id: l.case_id,
        label: l.label,
        judge: `${j.score} (${j.pass ? "pass" : "fail"})`,
      });
  }
  return { n, of, rate: of ? n / of : null, disagreements, unjudged };
}

/** Deterministic spread over rubrics, so the 15 cover every rubric and the order hides the grouping. */
export function pickForLabelling<T extends { caseId: string; rubric: string }>(
  eligible: T[],
  count = 15,
): T[] {
  const byRubric = new Map<string, T[]>();
  for (const e of [...eligible].sort((a, b) => a.caseId.localeCompare(b.caseId))) {
    byRubric.set(e.rubric, [...(byRubric.get(e.rubric) ?? []), e]);
  }
  const queues = [...byRubric.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, q]) => q);
  const picked: T[] = [];
  while (picked.length < count && queues.some((q) => q.length)) {
    for (const q of queues) {
      const next = q.shift();
      if (next && picked.length < count) picked.push(next);
    }
  }
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  return picked.sort((a, b) => h(a.caseId).localeCompare(h(b.caseId)));
}
