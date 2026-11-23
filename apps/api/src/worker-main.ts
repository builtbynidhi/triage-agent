/** pnpm api:worker: drains the job queue, running the agent for each queued ticket. */
import { createWorker } from "./worker.ts";
import { openRuntime, todayInIndia } from "./runtime.ts";

const rt = openRuntime();
const worker = createWorker({
  store: rt.store,
  runs: rt.runs,
  queue: rt.queue,
  router: rt.router(),
  retriever: rt.retriever(),
  today: () => rt.pinnedToday ?? todayInIndia(),
  collector: rt.telemetry.collector,
  captureContent: rt.captureContent,
});
const loop = worker.start(1000);
console.error(
  "triage worker running (PROVIDER_MODE=%s; traces: %s; message content %s)",
  rt.env.PROVIDER_MODE ?? "replay",
  rt.telemetry.exporters.join(", "),
  rt.captureContent ? "CAPTURED" : "not captured",
);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void loop.stop().then(() => process.exit(0)));
}
