import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@huggingface/transformers";

/**
 * Local model settings, shared by the embedder and the cross-encoder reranker.
 * Models download once from the Hugging Face hub into .cache/models (gitignored), then run
 * on the CPU with no network. Set MODELS_OFFLINE=1 to forbid downloads entirely, as in a
 * locked-down CI job with the cache restored.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

let configured = false;
export function configureLocalModels(): void {
  if (configured) return;
  env.cacheDir = process.env.MODEL_CACHE_DIR ?? resolve(repoRoot, ".cache/models");
  env.allowRemoteModels = process.env.MODELS_OFFLINE !== "1";
  configured = true;
}
