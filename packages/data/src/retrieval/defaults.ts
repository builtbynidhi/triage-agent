import type { TriageStore } from "../store.ts";
import { createLocalEmbedder, type EmbeddingModelName } from "./embedder.ts";
import { createCrossEncoderReranker } from "./rerank.ts";
import { createPolicyRetriever, type PolicyRetriever } from "./retriever.ts";

/**
 * The production retrieval configuration. Chosen in docs/adr/0005-retrieval-configuration.md
 * from the measurements in docs/retrieval.md: hybrid FTS5 + vector search, RRF, and a local
 * cross-encoder reranking the fused top 10 down to k.
 * Change it only with a new measurement and an ADR.
 */
export const DEFAULT_EMBEDDING_MODEL: EmbeddingModelName = "bge-small-en-v1.5";
export const DEFAULT_RERANKER = "cross-encoder" as const;

export function createDefaultRetriever(store: TriageStore): PolicyRetriever {
  return createPolicyRetriever({
    store,
    embedder: createLocalEmbedder(DEFAULT_EMBEDDING_MODEL),
    reranker: createCrossEncoderReranker(),
  });
}
