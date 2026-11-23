/**
 * The eval harness.
 *
 *   pnpm eval                              replay every case from committed recordings (no API calls)
 *   pnpm eval --mode record-missing        record only cases that have no recording yet (free tier)
 *   pnpm eval --case refund --repeats 1    a subset, one repeat
 *   pnpm eval --write-baseline             also write evals/baseline.json from this run
 *
 * Recording modes use the primary model only, so a run ends cleanly at its daily cap instead of
 * spending the fallback's small free quota; add --fallback to allow the fallback anyway.
 *
 * Writes evals/report/report.json and report.md, prints the scorecard, and compares against
 * evals/baseline.json when it exists. Exits non-zero if any run is incomplete.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_DTYPE, DEFAULT_EMBEDDING_MODEL } from "@triage/data";
import { FALLBACK, MODES, PRIMARY, type ProviderMode } from "@triage/providers";
import { loadCases } from "./src/load-cases.ts";
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
    fallback: { type: "boolean", default: false },
    out: { type: "string", default: join(root, "evals", "report") },
  },
});

if (!(MODES as readonly string[]).includes(values.mode!)) {
  console.error(`--mode must be one of ${MODES.join(", ")}`);
  process.exit(1);
}
const mode = values.mode as ProviderMode;
const repeats = Math.max(1, Number(values.repeats));
const cases = loadCases().filter((c) => !values.case || c.data.id.includes(values.case));
if (!cases.length) {
  console.error(`no case matches "${values.case}"`);
  process.exit(1);
}

console.error(`eval: ${cases.length} cases × ${repeats} repeat(s), mode ${mode}`);
const recording = mode === "record" || mode === "record-missing";
const runs = await runSuite({
  cases,
  repeats,
  mode,
  primaryOnly: recording && !values.fallback,
  onProgress: (l) => console.error(`  ${l}`),
});
const card = score(runs);
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
              failure: {
                promptHash: r.result!.prompt.hash,
                validation: r
                  .result!.steps.filter((s) => s.kind === "validation")
                  .map((s) => s.output),
                budgetAtExit: r.result!.usage,
                retrievedClauseIds: r.result!.citableClauseIds,
              },
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
  console.error(`wrote ${baselinePath}`);
}
if (card.runs.incomplete) process.exitCode = 1;
