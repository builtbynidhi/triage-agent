import { describe, expect, it } from "vitest";
import { createDefaultRetriever, createSqliteStore, openDb, seed, SEED_TODAY } from "@triage/data";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CASSETTE_DIR, CassetteMissError, createDefaultRouter } from "@triage/providers";
import { runAgent } from "./machine.ts";
import { connectTools } from "./tools.ts";

/**
 * Replays the committed recording of the Phase 6 done-when run, through the REAL production
 * pieces: hybrid retrieval with local models, the MCP server, and the router in replay mode.
 * No API keys, no network. It proves a run recorded on one machine replays on another (CI runs
 * Linux x86; the recording was made on macOS arm64): every byte sent to the model, tool results
 * included, must come out identical, or the request key changes and replay misses.
 */
describe("a committed recording replays end to end with zero API calls", () => {
  it("the sealed-return ticket reaches the same AUTO_REPLY", async () => {
    const db = openDb(":memory:");
    seed(db);
    const store = createSqliteStore(db);
    const tools = await connectTools({
      store,
      tenantId: "tenant_a",
      today: SEED_TODAY,
      retriever: createDefaultRetriever(store),
    });
    try {
      const r = await diagnose(() =>
        runAgent({
          ticket: {
            text: "I got the blender on 18 Nov and it's still sealed. Can I return it? Order A-10410",
            channel: "email",
          },
          tools,
          router: createDefaultRouter({ mode: "replay", env: {} }),
          today: SEED_TODAY,
        }),
      );
      expect(r.exit).toBe("decided");
      expect(r.decision.decision).toBe("AUTO_REPLY");
      expect(r.decision.clause_ids).toContain("returns.window");
      expect(
        r.steps.filter((s) => s.kind === "model_call").every((s) => s.source === "cassette"),
      ).toBe(true);
    } finally {
      await tools.close();
    }
  }, 60_000);
});

/**
 * On a replay miss, find the committed cassette whose request is closest (same number of
 * messages) and print the JSON paths that differ, so a cross-machine difference is visible
 * straight from the CI log instead of guessed at.
 */
async function diagnose<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof CassetteMissError)) throw err;
    const mine = err.request as unknown;
    const candidates = readdirSync(CASSETTE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map(
        (f) =>
          JSON.parse(readFileSync(join(CASSETTE_DIR, f), "utf8")) as {
            key: string;
            request: { messages: unknown[] };
          },
      )
      .filter((c) => c.request.messages.length === err.request.messages.length);
    for (const c of candidates) {
      const diffs = diffPaths(c.request, mine).slice(0, 8);
      console.error(
        `replay miss vs cassette ${c.key.slice(0, 12)} (${diffs.length} differing paths):\n${diffs.join("\n")}`,
      );
    }
    throw err;
  }
}

function diffPaths(a: unknown, b: unknown, path = "$"): string[] {
  if (
    typeof a !== typeof b ||
    Array.isArray(a) !== Array.isArray(b) ||
    a === null ||
    b === null ||
    typeof a !== "object"
  ) {
    return JSON.stringify(a) === JSON.stringify(b)
      ? []
      : [
          `${path}: recorded=${JSON.stringify(a)?.slice(0, 160)} | now=${JSON.stringify(b)?.slice(0, 160)}`,
        ];
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  return [...keys].flatMap((k) =>
    diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`),
  );
}
