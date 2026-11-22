import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultRetriever, createSqliteStore, openDb, seed } from "@triage/data";
import { evalDerivedQuestions, heldOutQuestions, type Question } from "./retrieval-eval.ts";

/**
 * Retrieval regression gate, using the real production retriever and real local models.
 * Fails if clause hit@4 falls below what docs/retrieval.md reports for the production
 * configuration, by more than the measured cross-platform spread.
 *
 * Why a tolerance at all: production runs fp32, and macOS arm64 and the Linux x86 CI runner
 * measured identically on 2026-11-22 (13/27 eval-derived, 31/32 held-out). Under int8, where kernels
 * differ across CPUs, Linux measured two questions lower, which is why production moved to fp32.
 * One question of slack remains for any residual floating-point noise; a real regression (a
 * broken index, a wrong model) drops far more. The gate prints its misses for diagnosis.
 * To improve the baseline, change retrieval, then re-run `pnpm eval:retrieval`.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const report = JSON.parse(readFileSync(resolve(root, "evals/report/retrieval.json"), "utf8")) as {
  chosen: { name: string };
  runs: { config: { name: string }; evalDerived: { hit4: number }; heldOut: { hit4: number } }[];
};
const baseline = report.runs.find((r) => r.config.name === report.chosen.name)!;

/** Questions allowed to flip across CPUs, per set (see above). */
const TOLERANCE = { evalDerived: 1, heldOut: 1 } as const;

const db = openDb(":memory:");
seed(db);
const retriever = createDefaultRetriever(createSqliteStore(db));

async function hitRate(questions: Question[]): Promise<{ rate: number; misses: string[] }> {
  const misses: string[] = [];
  for (const q of questions) {
    const top4 = (await retriever.search("tenant_a", q.q, 4)).hits.map((h) => h.clauseId);
    if (!top4.some((id) => q.gold.includes(id))) misses.push(q.id);
  }
  return { rate: (questions.length - misses.length) / questions.length, misses };
}

describe(`retrieval hit@4 (${report.chosen.name})`, () => {
  it("the committed report describes the production configuration", () => {
    expect(baseline, "re-run pnpm eval:retrieval: the report is stale").toBeDefined();
    expect(retriever.id).toContain("bge-small-en-v1.5");
    expect(retriever.id).toContain("cross-encoder");
  });

  it.each([
    ["eval-derived", evalDerivedQuestions, "evalDerived"],
    ["held-out", heldOutQuestions, "heldOut"],
  ] as const)(
    "%s: at least the committed baseline",
    async (label, questions, key) => {
      const qs = questions();
      const { rate, misses } = await hitRate(qs);
      console.log(
        `retrieval hit@4 ${label}: ${Math.round(rate * qs.length)}/${qs.length} (${(rate * 100).toFixed(1)}%)`,
      );
      console.log(`retrieval misses ${label}: ${misses.join(", ") || "none"}`);
      expect(rate).toBeGreaterThanOrEqual(baseline[key].hit4 - TOLERANCE[key] / qs.length - 1e-9);
    },
    120_000,
  );
});
