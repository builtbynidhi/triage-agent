import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderResult, ProviderId } from "./types.ts";

/** A stored answer, enough to serve the same request again without calling a provider. */
export interface StoredResponse {
  provider: ProviderId;
  model: string;
  result: ProviderResult;
}

/**
 * Content-addressed response cache, keyed by the sha256 of the full (canonical, redacted)
 * request. Used in `live` mode so repeating a request during development costs nothing.
 * The file cache lives in .cache/llm (gitignored); cassettes are the committed equivalent.
 */
export interface ResponseCache {
  get(key: string): StoredResponse | undefined;
  set(key: string, value: StoredResponse): void;
}

export function createMemoryCache(): ResponseCache {
  const m = new Map<string, StoredResponse>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
}

export function createFileCache(dir: string): ResponseCache {
  return {
    get(key) {
      try {
        return JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as StoredResponse;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${key}.json`);
      writeFileSync(`${file}.tmp`, JSON.stringify(value));
      renameSync(`${file}.tmp`, file);
    },
  };
}
