import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { configureLocalModels } from "./models.ts";

/** A fused candidate going into reranking. */
export interface Candidate {
  clauseId: string;
  title: string;
  text: string;
  /** RRF score from fusion. */
  fusedScore: number;
}

export interface Reranked extends Candidate {
  rerankScore: number;
}

/** Swappable: the retriever only knows this interface. */
export interface Reranker {
  readonly id: string;
  rerank(query: string, candidates: Candidate[]): Promise<Reranked[]>;
}

const byScore = (a: Reranked, b: Reranked) =>
  b.rerankScore - a.rerankScore ||
  b.fusedScore - a.fusedScore ||
  a.clauseId.localeCompare(b.clauseId);

/** Keeps the fusion order. The baseline that shows what a real reranker adds. */
export const fusionOnly: Reranker = {
  id: "none",
  async rerank(_query, candidates) {
    return candidates.map((c) => ({ ...c, rerankScore: c.fusedScore })).sort(byScore);
  },
};

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in " +
    "into is it its me my no not of on or our please so that the their them then there this " +
    "to was we were what when where which who why will with would you your hai hain ka ki ke " +
    "ko kya mera mere meri nahi se"
  ).split(" "),
);

/** Lower-case words, stopwords dropped, crude suffix stripping so "returned" ~ "return". */
function terms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  return new Set(
    words
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/u, "") || w),
  );
}

/**
 * A transparent, zero-dependency reranker: the fusion score (normalised to 0..1) plus how much
 * of the query's vocabulary the clause covers, with title matches counted again because a
 * clause's title states its topic. Free and instant, but blind to meaning beyond shared words.
 */
export const heuristicReranker: Reranker = {
  id: "heuristic-v1",
  async rerank(query, candidates) {
    const q = terms(query);
    const maxFused = Math.max(...candidates.map((c) => c.fusedScore), Number.EPSILON);
    return candidates
      .map((c) => {
        const title = terms(c.title);
        const body = terms(`${c.title} ${c.text}`);
        const hit = (set: Set<string>) =>
          q.size ? [...q].filter((t) => set.has(t)).length / q.size : 0;
        const rerankScore = c.fusedScore / maxFused + 0.5 * hit(body) + 0.5 * hit(title);
        return { ...c, rerankScore: Math.round(rerankScore * 1000) / 1000 };
      })
      .sort(byScore);
  },
};

const crossEncoders = new Map<string, Promise<[PreTrainedTokenizer, PreTrainedModel]>>();

/**
 * A cross-encoder reads the query and the clause together and scores relevance directly,
 * which catches meaning that word overlap and independent embeddings miss. Runs locally
 * (MS MARCO MiniLM, q8, about 23 MB).
 */
export function createCrossEncoderReranker(model = "Xenova/ms-marco-MiniLM-L-6-v2"): Reranker {
  const load = () => {
    configureLocalModels();
    let p = crossEncoders.get(model);
    if (!p) {
      p = Promise.all([
        AutoTokenizer.from_pretrained(model),
        AutoModelForSequenceClassification.from_pretrained(model, { dtype: "q8" }),
      ]);
      crossEncoders.set(model, p);
    }
    return p;
  };
  return {
    id: `cross-encoder:${model}@q8`,
    async rerank(query, candidates) {
      if (candidates.length === 0) return [];
      const [tokenizer, ce] = await load();
      const inputs = tokenizer(
        candidates.map(() => query),
        {
          text_pair: candidates.map((c) => `${c.title}. ${c.text}`),
          padding: true,
          truncation: true,
        },
      );
      const { logits } = (await ce(inputs)) as { logits: { data: Float32Array } };
      return candidates
        .map((c, i) => ({ ...c, rerankScore: Math.round(logits.data[i]! * 1000) / 1000 }))
        .sort(byScore);
    },
  };
}
