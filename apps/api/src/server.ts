/**
 * pnpm api:start: the HTTP API (port 3200 by default, loopback only).
 * The agent runs in a separate process: pnpm api:worker.
 */
import { createApp } from "./app.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { openRuntime } from "./runtime.ts";

const rt = openRuntime();
const app = createApp({
  store: rt.store,
  runs: rt.runs,
  jwtSecret: rt.jwtSecret,
  limiter: createRateLimiter({ capacity: 30, refillPerSec: 0.5 }), // 30 tickets at once, then one every 2 s per merchant
  ...(rt.pinnedToday ? { today: rt.pinnedToday } : {}),
});
const port = Number(rt.env.API_PORT ?? 3200);
app.listen(port, "127.0.0.1", () =>
  console.error(`triage API listening on http://127.0.0.1:${port}`),
);
