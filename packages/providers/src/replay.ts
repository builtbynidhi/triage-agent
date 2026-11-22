import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredResponse } from "./cache.ts";
import type { ChatRequest } from "./types.ts";

/**
 * Record and replay of model calls.
 *
 *   replay          (default) answers ONLY from committed cassettes; a miss throws. Never calls
 *                   an API and needs no keys. Tests and CI run here.
 *   record-missing  answers from a cassette if one exists, otherwise calls the API once and
 *                   writes a new cassette. The frugal way to record: nothing is re-recorded.
 *   record          always calls the API and overwrites the cassette. Use deliberately.
 *   live            calls the API (through the response cache) and writes no cassettes.
 */
export const MODES = ["replay", "record-missing", "record", "live"] as const;
export type ProviderMode = (typeof MODES)[number];

export function modeFromEnv(env: Record<string, string | undefined> = process.env): ProviderMode {
  const v = (env.PROVIDER_MODE ?? "replay").trim();
  if (!(MODES as readonly string[]).includes(v)) {
    throw new Error(`PROVIDER_MODE must be one of ${MODES.join(", ")}; got "${v}"`);
  }
  return v as ProviderMode;
}

export interface Cassette extends StoredResponse {
  version: 1;
  key: string;
  recordedAt: string;
  /** The redacted request, so a reviewer can see exactly what was asked. */
  request: ChatRequest;
}

export class CassetteMissError extends Error {
  readonly key: string;
  constructor(key: string, req: ChatRequest) {
    const firstUser = req.messages.find((m) => m.role === "user");
    const hint =
      firstUser && "content" in firstUser
        ? firstUser.content.slice(0, 80).replace(/\s+/g, " ")
        : "";
    super(
      `No recorded response for request ${key.slice(0, 12)}… ("${hint}"). ` +
        `Replay mode never calls a live API. Record it once with PROVIDER_MODE=record-missing, ` +
        `then commit the new file in evals/cassettes/.`,
    );
    this.name = "CassetteMissError";
    this.key = key;
  }
}

export interface CassetteStore {
  get(key: string): Cassette | undefined;
  put(cassette: Cassette): void;
}

/** One JSON file per request, named by its key, under evals/cassettes/ (committed). */
export function createCassetteStore(dir: string): CassetteStore {
  return {
    get(key) {
      const file = join(dir, `${key}.json`);
      if (!existsSync(file)) return undefined;
      return JSON.parse(readFileSync(file, "utf8")) as Cassette;
    },
    put(c) {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${c.key}.json`);
      writeFileSync(`${file}.tmp`, JSON.stringify(c, null, 2) + "\n");
      renameSync(`${file}.tmp`, file);
    },
  };
}

export function createMemoryCassetteStore(): CassetteStore & { all(): Cassette[] } {
  const m = new Map<string, Cassette>();
  return { get: (k) => m.get(k), put: (c) => void m.set(c.key, c), all: () => [...m.values()] };
}
