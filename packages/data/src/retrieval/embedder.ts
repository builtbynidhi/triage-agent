import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { EMBEDDING_DIM } from "../sqlite/migrations.ts";
import type { DocumentEmbedder } from "../store.ts";
import { configureLocalModels } from "./models.ts";

export interface Embedder extends DocumentEmbedder {
  readonly dim: number;
  embedQuery(text: string): Promise<Float32Array>;
}

export interface EmbeddingModelSpec {
  /** Hugging Face model with ONNX weights. */
  model: string;
  /** How token vectors become one sentence vector, as the model was trained. */
  pooling: "mean" | "cls";
  /** Some retrieval models expect queries (not documents) to carry an instruction prefix. */
  queryPrefix: string;
}

/** Candidates compared in docs/retrieval.md. All are 384-dimensional, matching policy_vec. */
export const EMBEDDING_MODELS = {
  "bge-small-en-v1.5": {
    model: "Xenova/bge-small-en-v1.5",
    pooling: "cls",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  "all-MiniLM-L6-v2": { model: "Xenova/all-MiniLM-L6-v2", pooling: "mean", queryPrefix: "" },
  "multilingual-MiniLM-L12-v2": {
    model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    pooling: "mean",
    queryPrefix: "",
  },
} as const satisfies Record<string, EmbeddingModelSpec>;

export type EmbeddingModelName = keyof typeof EMBEDDING_MODELS;

const pipelines = new Map<string, Promise<FeatureExtractionPipeline>>();

function load(model: string): Promise<FeatureExtractionPipeline> {
  configureLocalModels();
  let p = pipelines.get(model);
  if (!p) {
    // q8 weights: a quarter of the size of fp32, with negligible loss for retrieval.
    p = pipeline("feature-extraction", model, {
      dtype: "q8",
    }) as Promise<FeatureExtractionPipeline>;
    pipelines.set(model, p);
  }
  return p;
}

/** A local, CPU-only sentence embedder. The model loads lazily, once per process. */
export function createLocalEmbedder(name: EmbeddingModelName): Embedder {
  const spec: EmbeddingModelSpec = EMBEDDING_MODELS[name];
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    if (texts.length === 0) return [];
    const extractor = await load(spec.model);
    const out = await extractor(texts, { pooling: spec.pooling, normalize: true });
    const [rows, dim] = out.dims as [number, number];
    if (dim !== EMBEDDING_DIM)
      throw new Error(`${spec.model} gives ${dim} dims, index expects ${EMBEDDING_DIM}`);
    const data = out.data as Float32Array;
    return Array.from({ length: rows }, (_, i) => data.slice(i * dim, (i + 1) * dim));
  };
  return {
    id: `${spec.model}@q8/${spec.pooling}`,
    dim: EMBEDDING_DIM,
    embedDocuments: embed,
    async embedQuery(text) {
      return (await embed([spec.queryPrefix + text]))[0]!;
    },
  };
}
