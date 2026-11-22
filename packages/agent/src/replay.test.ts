import { describe, expect, it } from "vitest";
import { createDefaultRetriever, createSqliteStore, openDb, seed, SEED_TODAY } from "@triage/data";
import { createDefaultRouter } from "@triage/providers";
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
      const r = await runAgent({
        ticket: {
          text: "I got the blender on 18 Nov and it's still sealed. Can I return it? Order A-10410",
          channel: "email",
        },
        tools,
        router: createDefaultRouter({ mode: "replay", env: {} }),
        today: SEED_TODAY,
      });
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
