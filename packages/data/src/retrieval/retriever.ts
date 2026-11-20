import type { PolicyHit, TriageStore } from "../store.ts";
import type { Embedder } from "./embedder.ts";
import { reciprocalRankFusion } from "./fusion.ts";
import type { Reranker } from "./rerank.ts";

export type RetrievalMode = "hybrid" | "keyword" | "vector";

/** One ranked clause at one stage, for traces and the retrieval report. */
export interface StageHit {
  clauseId: string;
  score: number;
}

/** What happened inside one search: every stage's ranking, so a trace can show why. */
export interface RetrievalTrace {
  mode: RetrievalMode;
  keyword: StageHit[];
  vector: StageHit[];
  fused: StageHit[];
  reranked: StageHit[];
  ms: { keyword: number; vector: number; rerank: number; total: number };
}

export interface RetrievalResult {
  hits: PolicyHit[];
  trace: RetrievalTrace;
}

export interface PolicyRetriever {
  readonly id: string;
  search(
    tenantId: string,
    query: string,
    k: number,
    mode?: RetrievalMode,
  ): Promise<RetrievalResult>;
}

export interface RetrieverOptions {
  store: TriageStore;
  embedder: Embedder;
  reranker: Reranker;
  /** Candidates each method contributes. Spec: top 10. */
  perMethod?: number;
  /** Fused candidates handed to the reranker. Spec: rerank the top 10 down to k (4). */
  rerankDepth?: number;
}

const stage = (hits: { clauseId: string; score: number }[]): StageHit[] =>
  hits.map((h) => ({ clauseId: h.clauseId, score: h.score }));

/**
 * Hybrid policy retrieval: FTS5 keyword search and sqlite-vec vector search run in parallel,
 * are merged by reciprocal rank fusion, and the fused top 10 are reranked down to k.
 * `mode` runs one method alone, which is how docs/retrieval.md measures each in isolation.
 */
export function createPolicyRetriever(opts: RetrieverOptions): PolicyRetriever {
  const perMethod = opts.perMethod ?? 10;
  const rerankDepth = opts.rerankDepth ?? 10;
  let indexed: Promise<unknown> | undefined;
  const ensureIndex = () => (indexed ??= opts.store.syncPolicyVectors(opts.embedder));

  return {
    id: `hybrid(${opts.embedder.id}, rrf, ${opts.reranker.id})`,
    async search(tenantId, query, k, mode = "hybrid") {
      const t0 = performance.now();
      const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
        const s = performance.now();
        const v = await fn();
        return [v, performance.now() - s];
      };
      const [[keyword, msK], [vector, msV]] = await Promise.all([
        mode === "vector"
          ? Promise.resolve([[], 0] as [PolicyHit[], number])
          : timed(() => opts.store.searchPoliciesKeyword(tenantId, query, perMethod)),
        mode === "keyword"
          ? Promise.resolve([[], 0] as [PolicyHit[], number])
          : timed(async () => {
              await ensureIndex();
              return opts.store.searchPoliciesVector(
                tenantId,
                await opts.embedder.embedQuery(query),
                perMethod,
              );
            }),
      ]);

      let hits: PolicyHit[];
      let fusedStage: StageHit[] = [];
      let rerankedStage: StageHit[] = [];
      let msR = 0;
      if (mode === "keyword") hits = keyword.slice(0, k);
      else if (mode === "vector") hits = vector.slice(0, k);
      else {
        const fused = reciprocalRankFusion([keyword, vector], (h) => h.clauseId).slice(
          0,
          rerankDepth,
        );
        fusedStage = fused.map((f) => ({
          clauseId: f.item.clauseId,
          score: Math.round(f.score * 1e5) / 1e5,
        }));
        const [reranked, ms] = await timed(() =>
          opts.reranker.rerank(
            query,
            fused.map((f) => ({
              clauseId: f.item.clauseId,
              title: f.item.title,
              text: f.item.text,
              fusedScore: f.score,
            })),
          ),
        );
        msR = ms;
        rerankedStage = reranked.map((r) => ({ clauseId: r.clauseId, score: r.rerankScore }));
        hits = reranked.slice(0, k).map((r) => ({
          clauseId: r.clauseId,
          title: r.title,
          text: r.text,
          score: r.rerankScore,
        }));
      }
      return {
        hits,
        trace: {
          mode,
          keyword: stage(keyword),
          vector: stage(vector),
          fused: fusedStage,
          reranked: rerankedStage,
          ms: { keyword: msK, vector: msV, rerank: msR, total: performance.now() - t0 },
        },
      };
    },
  };
}
