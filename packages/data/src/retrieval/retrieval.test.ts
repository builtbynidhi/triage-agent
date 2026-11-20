import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM } from "../sqlite/migrations.ts";
import { createSqliteStore, openDb, seed } from "../index.ts";
import type { Embedder } from "./embedder.ts";
import { RRF_K, reciprocalRankFusion } from "./fusion.ts";
import { fusionOnly, heuristicReranker, type Reranker } from "./rerank.ts";
import { createPolicyRetriever } from "./retriever.ts";
import { contentWords } from "./text.ts";

/**
 * A deterministic stand-in for a real model: each content word hashes to a dimension, so
 * texts sharing words are near each other. It keeps these tests fast and offline; the real
 * models are exercised by evals/src/retrieval.test.ts.
 */
function fakeEmbedder(id = "fake-v1"): Embedder & { calls: number; texts: number } {
  const vec = (text: string) => {
    const v = new Float32Array(EMBEDDING_DIM);
    for (const w of contentWords(text)) {
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
      v[h % EMBEDDING_DIM]! += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  const e = {
    id,
    dim: EMBEDDING_DIM,
    calls: 0,
    texts: 0,
    async embedDocuments(texts: string[]) {
      e.calls++;
      e.texts += texts.length;
      return texts.map(vec);
    },
    async embedQuery(text: string) {
      return vec(text);
    },
  };
  return e;
}

const fresh = () => {
  const db = openDb(":memory:");
  seed(db);
  return { db, store: createSqliteStore(db) };
};

describe("reciprocal rank fusion", () => {
  it("scores 1/(k+rank) per list and sums across lists", () => {
    const fused = reciprocalRankFusion(
      [
        ["a", "b"],
        ["b", "c"],
      ],
      (x) => x,
    );
    const b = fused.find((f) => f.item === "b")!;
    // Exact to 12 digits: RRF scores are about 0.03, so the default 2-digit precision would
    // hide an off-by-one in the rank (a real mutation this test once missed).
    expect(b.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 12);
    expect(fused.find((f) => f.item === "a")!.score).toBe(1 / (RRF_K + 1));
    expect(b.ranks).toEqual([2, 1]);
    expect(fused[0]!.item).toBe("b"); // in both lists, so it wins
  });

  it("breaks ties deterministically: best single rank, then key", () => {
    const fused = reciprocalRankFusion(
      [
        ["x", "y"],
        ["y", "x"],
      ],
      (s) => s,
    );
    expect(fused.map((f) => f.item)).toEqual(["x", "y"]);
    expect(reciprocalRankFusion([["q"], ["p"]], (s) => s).map((f) => f.item)).toEqual(["p", "q"]);
  });

  it("uses ranks only, so a list's score scale cannot dominate", () => {
    const huge = [{ id: "a", s: 1e9 }];
    const tiny = [{ id: "b", s: 1e-9 }];
    const fused = reciprocalRankFusion([huge, tiny], (h) => h.id);
    expect(fused[0]!.score).toBe(fused[1]!.score);
  });
});

describe("vector index sync", () => {
  it("embeds every clause once, then nothing on the next sync", async () => {
    const { store } = fresh();
    const e = fakeEmbedder();
    expect(await store.syncPolicyVectors(e)).toEqual({ embedded: 30, total: 30 });
    expect(await store.syncPolicyVectors(e)).toEqual({ embedded: 0, total: 30 });
    expect(e.texts).toBe(30);
  });

  it("re-embeds only the clause whose text changed", async () => {
    const { db, store } = fresh();
    await store.syncPolicyVectors(fakeEmbedder());
    db.prepare(
      "UPDATE policy_chunks SET text = text || ' Updated.' WHERE clause_id = 'returns.window'",
    ).run();
    expect(await store.syncPolicyVectors(fakeEmbedder())).toEqual({ embedded: 1, total: 30 });
  });

  it("re-embeds everything when the model changes", async () => {
    const { store } = fresh();
    await store.syncPolicyVectors(fakeEmbedder("model-a"));
    expect(await store.syncPolicyVectors(fakeEmbedder("model-b"))).toEqual({
      embedded: 30,
      total: 30,
    });
  });

  it("drops vectors of deleted clauses and survives a full re-index", async () => {
    const { db, store } = fresh();
    await store.syncPolicyVectors(fakeEmbedder());
    db.prepare("DELETE FROM policy_chunks WHERE clause_id = 'contact.hours'").run();
    await store.syncPolicyVectors(fakeEmbedder());
    const vecRows = (db.prepare("SELECT COUNT(*) c FROM policy_vec").get() as { c: number }).c;
    expect(vecRows).toBe(29);
    seed(db); // re-seeding rebuilds policy_chunks; sync must repair, not duplicate
    expect((await store.syncPolicyVectors(fakeEmbedder())).total).toBe(30);
    expect((db.prepare("SELECT COUNT(*) c FROM policy_vec").get() as { c: number }).c).toBe(30);
  });

  it("returns nothing from vector search before the index is built", async () => {
    const { store } = fresh();
    expect(
      await store.searchPoliciesVector("tenant_a", await fakeEmbedder().embedQuery("refund"), 4),
    ).toEqual([]);
  });
});

describe("tenant-scoped retrieval", () => {
  const plant = (db: ReturnType<typeof openDb>) => {
    db.prepare(
      "INSERT INTO policy_chunks (clause_id, doc, title, text, tenant_id) VALUES ('nilgiri.trade_in', 'nilgiri', 'Phone trade-in', 'Trade in your old phone for store credit at Nilgiri.', 'tenant_b')",
    ).run();
    db.prepare(
      "INSERT INTO policy_fts (clause_id, title, text) VALUES ('nilgiri.trade_in', 'Phone trade-in', 'Trade in your old phone for store credit at Nilgiri.')",
    ).run();
  };

  it("a tenant-specific clause is found by its tenant and never by another", async () => {
    const { db, store } = fresh();
    plant(db);
    const e = fakeEmbedder();
    await store.syncPolicyVectors(e);
    const q = "trade in my old phone for store credit";
    const ids = async (t: string) => [
      ...(await store.searchPoliciesKeyword(t, q, 10)).map((h) => h.clauseId),
      ...(await store.searchPoliciesVector(t, await e.embedQuery(q), 10)).map((h) => h.clauseId),
    ];
    expect(await ids("tenant_b")).toContain("nilgiri.trade_in");
    expect(await ids("tenant_a")).not.toContain("nilgiri.trade_in");
  });

  it("shared clauses (tenant_id NULL) are visible to every tenant", async () => {
    const { store } = fresh();
    for (const t of ["tenant_a", "tenant_b"]) {
      const hits = await store.searchPoliciesKeyword(t, "cancel before dispatch", 3);
      expect(hits[0]?.clauseId).toBe("cancellation.before_dispatch");
    }
  });
});

describe("vector search", () => {
  it("returns cosine scores in [-1, 1], best first", async () => {
    const { store } = fresh();
    const e = fakeEmbedder();
    await store.syncPolicyVectors(e);
    const hits = await store.searchPoliciesVector(
      "tenant_a",
      await e.embedQuery("warranty period months"),
      5,
    );
    expect(hits).toHaveLength(5);
    for (const h of hits) expect(Math.abs(h.score)).toBeLessThanOrEqual(1.0001);
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
    expect(hits[0]!.clauseId.startsWith("warranty.")).toBe(true);
  });
});

describe("policy retriever", () => {
  it("runs keyword, vector and hybrid modes, and traces every stage", async () => {
    const { store } = fresh();
    const r = createPolicyRetriever({ store, embedder: fakeEmbedder(), reranker: fusionOnly });
    const q = "how long is the warranty on headphones";
    const kw = await r.search("tenant_a", q, 4, "keyword");
    const vec = await r.search("tenant_a", q, 4, "vector");
    const hy = await r.search("tenant_a", q, 4);
    expect(kw.trace.vector).toEqual([]);
    expect(vec.trace.keyword).toEqual([]);
    expect(hy.trace.keyword.length).toBeGreaterThan(0);
    expect(hy.trace.vector.length).toBeGreaterThan(0);
    expect(hy.trace.fused.length).toBeLessThanOrEqual(10);
    expect(hy.hits).toHaveLength(4);
    expect(hy.hits.map((h) => h.clauseId)).toEqual(
      hy.trace.reranked.slice(0, 4).map((h) => h.clauseId),
    );
    expect(hy.trace.ms.total).toBeGreaterThanOrEqual(0);
  });

  it("hands the fused top 10 to the reranker and returns its top k", async () => {
    const { store } = fresh();
    let seen = 0;
    const reverse: Reranker = {
      id: "reverse",
      async rerank(_q, cands) {
        seen = cands.length;
        return [...cands].reverse().map((c, i) => ({ ...c, rerankScore: cands.length - i }));
      },
    };
    const r = createPolicyRetriever({ store, embedder: fakeEmbedder(), reranker: reverse });
    const { hits, trace } = await r.search("tenant_a", "refund return delivery warranty cancel", 4);
    expect(seen).toBe(10);
    expect(hits[0]!.clauseId).toBe(trace.fused[9]!.clauseId); // the reranker's order wins
  });

  it("builds the vector index lazily, once", async () => {
    const { store } = fresh();
    const e = fakeEmbedder();
    const r = createPolicyRetriever({ store, embedder: e, reranker: fusionOnly });
    await Promise.all([r.search("tenant_a", "refund", 4), r.search("tenant_b", "return", 4)]);
    await r.search("tenant_a", "warranty", 4);
    expect(e.calls).toBe(1);
  });
});

describe("heuristic reranker", () => {
  it("promotes the clause whose title and text cover the query's words", async () => {
    const ranked = await heuristicReranker.rerank("warranty period for cables", [
      {
        clauseId: "returns.window",
        title: "Return window",
        text: "Return within 7 days.",
        fusedScore: 0.032,
      },
      {
        clauseId: "warranty.period",
        title: "Warranty periods",
        text: "Accessories such as cables carry 6 months.",
        fusedScore: 0.031,
      },
    ]);
    expect(ranked[0]!.clauseId).toBe("warranty.period");
  });
});
