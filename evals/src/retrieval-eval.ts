/**
 * Retrieval-only evaluation (Phase 4). Writes docs/retrieval.md and evals/report/retrieval.json.
 *
 *   pnpm eval:retrieval
 *
 * Two question sets:
 *  - eval-derived: every must_cite clause of every eval case, asked with the raw ticket text;
 *  - held-out: evals/retrieval/heldout.yaml, committed before anything was measured.
 * A question is a hit@4 when any of its gold clauses is in the top 4.
 *
 * Selection rule, fixed before the first run: the hybrid configuration with the best
 * eval-derived hit@4 (ties: higher eval-derived MRR, then the cheaper reranker). The report
 * still shows what that rule picks. The production default (DEFAULT_EMBEDDING_MODEL +
 * DEFAULT_RERANKER) was then decided from these measurements in ADR 0005, which explains
 * why it differs from the rule's pick.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_RERANKER,
  EMBEDDING_MODELS,
  createCrossEncoderReranker,
  createLocalEmbedder,
  createPolicyRetriever,
  createSqliteStore,
  fusionOnly,
  heuristicReranker,
  openDb,
  seed,
  type EmbeddingModelName,
  type RetrievalMode,
  type Reranker,
} from "@triage/data";
import { loadCases } from "./load-cases.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TENANT = "tenant_a"; // policies are shared, so either tenant sees the same clauses
const K = 4;
const DEPTH = 10;

export interface Question {
  set: "eval-derived" | "held-out";
  id: string;
  q: string;
  gold: string[];
}

export function evalDerivedQuestions(): Question[] {
  return loadCases().flatMap(({ data: c }) =>
    c.expect.must_cite.map((clause) => ({
      set: "eval-derived" as const,
      id: `${c.id}#${clause}`,
      q: c.ticket.text,
      gold: [clause],
    })),
  );
}

export function heldOutQuestions(): Question[] {
  const { questions } = parse(
    readFileSync(resolve(root, "evals/retrieval/heldout.yaml"), "utf8"),
  ) as {
    questions: { q: string; gold: string[] }[];
  };
  return questions.map((x, i) => ({
    set: "held-out",
    id: `heldout-${i + 1}`,
    q: x.q,
    gold: x.gold,
  }));
}

interface Config {
  name: string;
  mode: RetrievalMode;
  embedding: EmbeddingModelName | null;
  reranker: string | null;
}

interface QuestionResult {
  id: string;
  set: Question["set"];
  gold: string[];
  ranked: string[];
  rank: number | null; // 1-based rank of the first gold clause in the top 10
  ms: number;
}

interface Score {
  questions: number;
  hit1: number;
  hit4: number;
  mrr10: number;
}

const score = (rs: QuestionResult[]): Score => ({
  questions: rs.length,
  hit1: rs.filter((r) => r.rank === 1).length / rs.length,
  hit4: rs.filter((r) => r.rank !== null && r.rank <= K).length / rs.length,
  mrr10: rs.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rs.length,
});

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

async function runConfig(
  config: Config,
  questions: Question[],
  store: ReturnType<typeof createSqliteStore>,
  embedding: EmbeddingModelName,
  reranker: Reranker,
) {
  const retriever = createPolicyRetriever({
    store,
    embedder: createLocalEmbedder(embedding),
    reranker,
  });
  await retriever.search(TENANT, "warm up", DEPTH, config.mode); // load models and build the index first
  const results: QuestionResult[] = [];
  for (const q of questions) {
    const t = performance.now();
    const { hits } = await retriever.search(TENANT, q.q, DEPTH, config.mode);
    const ms = performance.now() - t;
    const ranked = hits.map((h) => h.clauseId);
    const idx = ranked.findIndex((id) => q.gold.includes(id));
    results.push({
      id: q.id,
      set: q.set,
      gold: q.gold,
      ranked,
      rank: idx === -1 ? null : idx + 1,
      ms,
    });
  }
  const bySet = (set: Question["set"]) => results.filter((r) => r.set === set);
  return {
    config,
    retrieverId: retriever.id,
    evalDerived: score(bySet("eval-derived")),
    heldOut: score(bySet("held-out")),
    medianMs: Math.round(median(results.map((r) => r.ms)) * 10) / 10,
    results,
  };
}

type Run = Awaited<ReturnType<typeof runConfig>>;

const RERANK_COST: Record<string, number> = { none: 0, heuristic: 1, "cross-encoder": 2 };

export function pickDefault(runs: Run[]): Run {
  return runs
    .filter((r) => r.config.mode === "hybrid")
    .sort(
      (a, b) =>
        b.evalDerived.hit4 - a.evalDerived.hit4 ||
        b.evalDerived.mrr10 - a.evalDerived.mrr10 ||
        RERANK_COST[a.config.reranker!]! - RERANK_COST[b.config.reranker!]!,
    )[0]!;
}

async function main() {
  const questions = [...evalDerivedQuestions(), ...heldOutQuestions()];
  const rerankers: Record<string, Reranker> = {
    none: fusionOnly,
    heuristic: heuristicReranker,
    "cross-encoder": createCrossEncoderReranker(),
  };
  const runs: Run[] = [];
  const models = Object.keys(EMBEDDING_MODELS) as EmbeddingModelName[];

  for (const model of models) {
    const db = openDb(":memory:");
    seed(db);
    const store = createSqliteStore(db);
    if (model === models[0]) {
      const cfg: Config = {
        name: "keyword only (FTS5/BM25)",
        mode: "keyword",
        embedding: null,
        reranker: null,
      };
      runs.push(await runConfig(cfg, questions, store, model, fusionOnly));
    }
    runs.push(
      await runConfig(
        { name: `vector only (${model})`, mode: "vector", embedding: model, reranker: null },
        questions,
        store,
        model,
        fusionOnly,
      ),
    );
    for (const [rname, reranker] of Object.entries(rerankers)) {
      const name = `hybrid: ${model} + RRF + ${rname === "none" ? "no rerank" : `${rname} rerank`}`;
      runs.push(
        await runConfig(
          { name, mode: "hybrid", embedding: model, reranker: rname },
          questions,
          store,
          model,
          reranker,
        ),
      );
    }
    console.error(`measured ${model}`);
  }

  const preRegistered = pickDefault(runs);
  const chosen = runs.find(
    (r) =>
      r.config.mode === "hybrid" &&
      r.config.embedding === DEFAULT_EMBEDDING_MODEL &&
      r.config.reranker === DEFAULT_RERANKER,
  )!;
  const keyword = runs.find((r) => r.config.mode === "keyword")!;
  // Compare against the BEST single vector method, not just the chosen model's own: beating a
  // weak baseline proves nothing. Best = eval-derived hit@4, then MRR (the selection metric).
  const vector = runs
    .filter((r) => r.config.mode === "vector")
    .sort(
      (a, b) =>
        b.evalDerived.hit4 - a.evalDerived.hit4 || b.evalDerived.mrr10 - a.evalDerived.mrr10,
    )[0]!;
  const date = new Date().toISOString().slice(0, 10);
  const nEval = keyword.evalDerived.questions;
  const nHeld = keyword.heldOut.questions;
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const of = (x: number, n: number) => `${Math.round(x * n)}/${n} (${pct(x)})`;

  const misses = (run: Run) =>
    run.results
      .filter((r) => r.rank === null || r.rank > K)
      .map(
        (r) =>
          `| ${r.set} | \`${r.id}\` | ${r.gold.map((g) => `\`${g}\``).join(", ")} | ${r.ranked
            .slice(0, K)
            .map((g) => `\`${g}\``)
            .join(", ")} | ${r.rank ?? "not in top 10"} |`,
      );

  const md = `# Retrieval evaluation

> Generated by \`pnpm eval:retrieval\` on ${date}, on ${process.platform}-${process.arch}. Do not edit by hand. Every number below was measured.

Policy retrieval is scored on two question sets:

- **Eval-derived (${nEval} questions):** every \`must_cite\` clause of every case in \`evals/cases/\`, searched with the raw ticket text exactly as the customer wrote it. This is the set the spec asks for. The spec suggested about 25; the 40 cases yield ${nEval}, and all are used rather than a hand-picked 25.
- **Held-out (${nHeld} questions):** \`evals/retrieval/heldout.yaml\`, one or more per policy clause, committed **before** any retrieval was built or measured (see git history). It plays no part in choosing the configuration.

A question is a **hit@4** when a correct clause is in the top 4, the number the agent sees. **MRR@10** rewards ranking the correct clause higher. Latency is the median per query on this machine, with models already loaded.

## Result

Production configuration ([ADR 0005](adr/0005-retrieval-configuration.md)): **${chosen.config.name}**.

The selection rule fixed before measuring (best eval-derived hit@4, then MRR, then the cheaper reranker) picks **${preRegistered.config.name}**${preRegistered === chosen ? ", the same configuration." : ". It is not used: ADR 0005 and the analysis below explain why."}

| Method | Eval-derived hit@4 | Held-out hit@4 | Eval-derived MRR@10 | Median latency |
|---|---|---|---|---|
| Keyword only (FTS5/BM25) | ${of(keyword.evalDerived.hit4, nEval)} | ${of(keyword.heldOut.hit4, nHeld)} | ${keyword.evalDerived.mrr10.toFixed(3)} | ${keyword.medianMs} ms |
| Best vector only (${vector.config.embedding}) | ${of(vector.evalDerived.hit4, nEval)} | ${of(vector.heldOut.hit4, nHeld)} | ${vector.evalDerived.mrr10.toFixed(3)} | ${vector.medianMs} ms |
| **Chosen hybrid** (${chosen.config.embedding}, ${chosen.config.reranker} rerank) | **${of(chosen.evalDerived.hit4, nEval)}** | **${of(chosen.heldOut.hit4, nHeld)}** | **${chosen.evalDerived.mrr10.toFixed(3)}** | ${chosen.medianMs} ms |

${(() => {
  const verdict = (s: "evalDerived" | "heldOut", label: string) => {
    const h = chosen[s].hit4;
    const vs = (name: string, x: number) =>
      h > x
        ? `beats ${name} (${pct(h)} vs ${pct(x)})`
        : h === x
          ? `ties ${name} (${pct(h)})`
          : `**loses to** ${name} (${pct(h)} vs ${pct(x)})`;
    return `On the ${label} set the chosen hybrid ${vs("keyword only", keyword[s].hit4)} and ${vs("the best vector-only method", vector[s].hit4)}.`;
  };
  return `${verdict("evalDerived", "eval-derived")} ${verdict("heldOut", "held-out")}`;
})()}

## Every configuration measured

| Configuration | Eval hit@1 | Eval hit@4 | Eval MRR@10 | Held-out hit@1 | Held-out hit@4 | Held-out MRR@10 | Median latency |
|---|---|---|---|---|---|---|---|
${runs.map((r) => `| ${r === chosen ? `**${r.config.name}** (chosen)` : r.config.name} | ${pct(r.evalDerived.hit1)} | ${pct(r.evalDerived.hit4)} | ${r.evalDerived.mrr10.toFixed(3)} | ${pct(r.heldOut.hit1)} | ${pct(r.heldOut.hit4)} | ${r.heldOut.mrr10.toFixed(3)} | ${r.medianMs} ms |`).join("\n")}

## Misses of the chosen configuration

Questions whose correct clause was not in the top 4. These are inputs for Phase 8, not things to hide.

| Set | Question | Gold | Top 4 returned | Rank of gold |
|---|---|---|---|---|
${misses(chosen).join("\n") || "| - | none | - | - | - |"}

${(() => {
  const notes = resolve(root, "evals/retrieval/analysis.md");
  return existsSync(notes) ? readFileSync(notes, "utf8").trim() + "\n\n" : "";
})()}## Setup

- Pipeline: FTS5 (BM25, title weighted 2x) and sqlite-vec (exact KNN, cosine) each return their top 10, merged by reciprocal rank fusion (k = 60). The fused top 10 are reranked, and the top 4 returned.
- Embedding models (all q8, 384 dimensions, run locally on the CPU): ${Object.entries(
    EMBEDDING_MODELS,
  )
    .map(([k, v]) => `\`${k}\` (${v.model})`)
    .join(", ")}.
- Rerankers: none (fusion order); \`heuristic-v1\` (fusion score plus query-term coverage); cross-encoder \`Xenova/ms-marco-MiniLM-L-6-v2\` (q8).
- Chosen retriever ID: \`${chosen.retrieverId}\`.
`;

  writeFileSync(resolve(root, "docs/retrieval.md"), md);
  mkdirSync(resolve(root, "evals/report"), { recursive: true });
  writeFileSync(
    resolve(root, "evals/report/retrieval.json"),
    JSON.stringify(
      {
        date,
        platform: `${process.platform}-${process.arch}`,
        preRegistered: preRegistered.config.name,
        chosen: {
          name: chosen.config.name,
          embedding: chosen.config.embedding,
          reranker: chosen.config.reranker,
        },
        runs: runs.map(({ results, ...r }) => ({
          ...r,
          misses: results.filter((x) => x.rank === null || x.rank > K),
        })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(md);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
