/**
 * The eval harness.
 *
 *   pnpm eval                              replay every case from committed recordings (no API calls)
 *   pnpm eval --mode record-missing        record only cases that have no recording yet (free tier)
 *   pnpm eval --case refund --repeats 1    a subset, one repeat
 *   pnpm eval --write-baseline             also write evals/baseline.json and evals/badge.json from this run
 *   pnpm eval --canary --mode live         the five cases in evals/canary.json against live models (nightly)
 *   pnpm eval --allow-incomplete           exit 0 even if some runs could not be scored (CI: the gate decides)
 *
 * Writes evals/report/report.json and report.md, prints the scorecard, and compares against
 * evals/baseline.json when it exists. Exits non-zero if any run is incomplete.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { failureDetail } from "@triage/agent";
import { DEFAULT_DTYPE, DEFAULT_EMBEDDING_MODEL } from "@triage/data";
import { FALLBACK, MODES, PRIMARY, type ProviderMode } from "@triage/providers";
import { loadCases } from "./src/load-cases.ts";
import { agreement, AI_LABELS_FILE, LABELS_FILE, loadLabels } from "./src/labels.ts";
import { score } from "./src/metrics.ts";
import { compare, renderMarkdown, toBaseline, type Baseline } from "./src/report.ts";
import { runSuite, suiteMeta } from "./src/runner.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    mode: { type: "string", default: process.env.PROVIDER_MODE ?? "replay" },
    repeats: { type: "string", default: "3" },
    case: { type: "string" },
    "write-baseline": { type: "boolean", default: false },
    canary: { type: "boolean", default: false },
    "allow-incomplete": { type: "boolean", default: false },
    out: { type: "string", default: join(root, "evals", "report") },
  },
});

if (!(MODES as readonly string[]).includes(values.mode!)) {
  console.error(`--mode must be one of ${MODES.join(", ")}`);
  process.exit(1);
}
const mode = values.mode as ProviderMode;
const repeats = Math.max(1, Number(values.repeats));
const canary = values.canary
  ? new Set(
      (JSON.parse(readFileSync(join(root, "evals", "canary.json"), "utf8")) as { cases: string[] })
        .cases,
    )
  : null;
const cases = loadCases().filter(
  (c) => (!values.case || c.data.id.includes(values.case)) && (!canary || canary.has(c.data.id)),
);
if (!cases.length) {
  console.error(`no case matches "${values.case}"`);
  process.exit(1);
}

console.error(`eval: ${cases.length} cases × ${repeats} repeat(s), mode ${mode}`);
const runs = await runSuite({ cases, repeats, mode, onProgress: (l) => console.error(`  ${l}`) });
const card = score(runs);
card.judgeAgreement =
  agreement(loadLabels(join(root, "evals", "labels", LABELS_FILE)), runs) ?? card.judgeAgreement;
card.judgeAgreementAi =
  agreement(loadLabels(join(root, "evals", "labels", AI_LABELS_FILE)), runs) ??
  card.judgeAgreementAi;
const meta = suiteMeta(mode, repeats);
const route = `${PRIMARY.model} primary → ${FALLBACK.model} fallback; retrieval ${DEFAULT_EMBEDDING_MODEL} (${DEFAULT_DTYPE}) + cross-encoder`;
const md = renderMarkdown(meta, card, runs, route);

mkdirSync(values.out!, { recursive: true });
writeFileSync(join(values.out!, "report.md"), md);
writeFileSync(
  join(values.out!, "report.json"),
  JSON.stringify(
    {
      meta: { ...meta, route },
      scorecard: card,
      runs: runs.map((r) => ({
        caseId: r.caseId,
        category: r.category,
        repeat: r.repeat,
        complete: r.complete,
        incompleteReason: r.incompleteReason,
        latencyMs: r.latencyMs,
        grade: r.grade,
        decision: r.result?.decision,
        exit: r.result?.exit,
        exitReason: r.result?.exitReason,
        repaired: r.result?.repaired,
        usage: r.result?.usage,
        listPriceUsd: r.result?.listPriceUsd,
        providers: [
          ...new Set(
            r.result?.steps
              .filter((s) => s.kind === "model_call")
              .map((s) => `${s.provider}/${s.model}`) ?? [],
          ),
        ],
        // What a failed run needs for triage without re-running (spec, Observability).
        ...(r.grade && !r.grade.pass
          ? {
              failure: failureDetail(r.result!),
            }
          : {}),
      })),
    },
    null,
    2,
  ) + "\n",
);
console.log(md);

const baselinePath = join(root, "evals", "baseline.json");
const now = toBaseline(meta, card, runs);
if (existsSync(baselinePath)) {
  const before = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
  console.log(
    `\n## Against baseline (${before.date})\n\n${compare(before, now)
      .map((l) => `- ${l}`)
      .join("\n")}`,
  );
}
if (values["write-baseline"]) {
  writeFileSync(baselinePath, JSON.stringify(now, null, 2) + "\n");
  // The README's evals badge reads this file (shields.io endpoint format): cases that passed every repeat.
  const scored = Object.values(now.cases);
  const clean = scored.filter((r) => r === 1).length;
  const share = scored.length ? clean / scored.length : 0;
  writeFileSync(
    join(root, "evals", "badge.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        label: "evals",
        message: `${clean}/${scored.length} cases pass every repeat`,
        color:
          share >= 0.9
            ? "brightgreen"
            : share >= 0.75
              ? "yellowgreen"
              : share >= 0.6
                ? "yellow"
                : "orange",
      },
      null,
      2,
    ) + "\n",
  );
  console.error(`wrote ${baselinePath} and evals/badge.json`);
}
// A run that could not be scored is reported, never counted as a pass, and by default fails the command.
// CI passes --allow-incomplete because scripts/gate.mjs decides what an unscored case means there.
if (card.runs.incomplete && !values["allow-incomplete"]) process.exitCode = 1;
