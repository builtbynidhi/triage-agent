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

/**
 * Weight precision. q8 is a quarter of the size, but int8 maths is implemented differently on
 * ARM and x86, so near-ties rank differently across machines (measured: a recording made on
 * macOS missed on the Linux CI runner). fp32 differences across CPUs are around 1e-6, so
 * production uses fp32; q8 remains for the size/quality comparison in docs/retrieval.md.
 */
export type ModelDtype = "fp32" | "q8";

const pipelines = new Map<string, Promise<FeatureExtractionPipeline>>();

function load(model: string, dtype: ModelDtype): Promise<FeatureExtractionPipeline> {
  configureLocalModels();
  const cacheKey = `${model}@${dtype}`;
  let p = pipelines.get(cacheKey);
  if (!p) {
    p = pipeline("feature-extraction", model, {
      dtype,
    }) as Promise<FeatureExtractionPipeline>;
    pipelines.set(cacheKey, p);
  }
  return p;
}

/** A local, CPU-only sentence embedder. The model loads lazily, once per process. */
export function createLocalEmbedder(name: EmbeddingModelName, dtype: ModelDtype = "q8"): Embedder {
  const spec: EmbeddingModelSpec = EMBEDDING_MODELS[name];
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    if (texts.length === 0) return [];
    const extractor = await load(spec.model, dtype);
    const out = await extractor(texts, { pooling: spec.pooling, normalize: true });
    const [rows, dim] = out.dims as [number, number];
    if (dim !== EMBEDDING_DIM)
      throw new Error(`${spec.model} gives ${dim} dims, index expects ${EMBEDDING_DIM}`);
    const data = out.data as Float32Array;
    return Array.from({ length: rows }, (_, i) => data.slice(i * dim, (i + 1) * dim));
  };
  return {
    id: `${spec.model}@${dtype}/${spec.pooling}`,
    dim: EMBEDDING_DIM,
    embedDocuments: embed,
    async embedQuery(text) {
      return (await embed([spec.queryPrefix + text]))[0]!;
    },
  };
}
