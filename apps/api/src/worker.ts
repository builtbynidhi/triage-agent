import {
  connectTools,
  failureDetail,
  loadSystemPrompt,
  runAgent,
  type StepRecord as AgentStep,
} from "@triage/agent";
import type { JobQueue, PolicyRetriever, RunStore, StepInput, TriageStore } from "@triage/data";
import type { Router } from "@triage/providers";
import type { SpanCollector } from "@triage/telemetry";

/**
 * The worker drains the queue: claim a job under a lease, run the agent, store the trace and the
 * decision, file the proposal as a pending approval. It is a separate process from the API, so a
 * slow model never holds up a request, and a crash loses nothing: the lease expires and the job is
 * claimed again. A failed attempt retries with backoff and is dead-lettered when the attempts run
 * out, and then the run is marked failed with the reason.
 */
export interface WorkerDeps {
  store: TriageStore;
  runs: RunStore;
  queue: JobQueue;
  router: Pick<Router, "complete">;
  retriever?: PolicyRetriever;
  /** Today, YYYY-MM-DD (the agent shows it to the model; tools use the same date). */
  today: () => string;
  leaseMs?: number;
  /** Where each run's finished spans are collected, to be saved with the run. Unset: no trace is kept. */
  collector?: SpanCollector;
  /** Record prompts and tool content on the spans. Off unless CAPTURE_MESSAGE_CONTENT is true. */
  captureContent?: boolean;
}

export type Outcome = "idle" | "done" | "retry" | "dead";

/** The agent's step, in the shape the run store keeps. Model-call details go in `output`. */
function toStep(s: AgentStep): StepInput {
  const output =
    s.kind === "model_call"
      ? {
          provider: s.provider,
          model: s.model,
          source: s.source,
          tokens: s.tokens,
          list_price_usd: s.listPriceUsd,
          ...(s.output as object),
        }
      : s.output;
  return { seq: s.seq, kind: s.kind, name: s.name, input: s.input, output, durationMs: s.ms };
}

export function createWorker(deps: WorkerDeps) {
  const { store, runs, queue } = deps;

  async function processOne(): Promise<Outcome> {
    const job = queue.claim(deps.leaseMs ? { leaseMs: deps.leaseMs } : {});
    if (!job) return "idle";
    const run = runs.findRun(job.runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) {
      queue.complete(job.id); // already finished (a duplicate delivery) or gone: nothing to do
      return "done";
    }
    runs.markRunning(run.id);
    runs.resetSteps(run.id); // a retried attempt starts its trace afresh
    let tools: Awaited<ReturnType<typeof connectTools>> | undefined;
    try {
      const today = deps.today();
      tools = await connectTools({
        store,
        tenantId: run.tenantId,
        today,
        ...(deps.retriever ? { retriever: deps.retriever } : {}),
      });
      const result = await runAgent({
        ticket: {
          text: run.ticket.text,
          channel: run.ticket.channel as "email" | "chat" | "web" | "voice",
          ...(run.ticket.orderId ? { orderId: run.ticket.orderId } : {}),
        },
        tools,
        router: deps.router,
        today,
        onStep: (s) => runs.appendStep(run.id, toStep(s)),
        traceAttributes: { "triage.run_id": run.id, "triage.tenant_id": run.tenantId },
        ...(deps.captureContent ? { captureContent: true } : {}),
      });
      // The model being unreachable is transient: retry the job rather than record a fake decision.
      if (result.exit === "provider_error")
        throw new Error(result.exitReason ?? "model unavailable");
      const modelSteps = result.steps.filter((s) => s.kind === "model_call" && s.tokens);
      runs.completeRun(run.id, {
        status: result.proposal ? "awaiting_approval" : "done",
        decision: result.decision.decision,
        decisionJson: {
          ...result.decision,
          exit: result.exit,
          exit_reason: result.exitReason ?? null,
          downgraded: result.downgraded,
          repaired: result.repaired,
          prompt: result.prompt,
          // A run that ended early keeps what is needed to triage it without re-running it.
          ...(result.exit !== "decided" ? { failure: failureDetail(result) } : {}),
        },
        inputTokens: modelSteps.reduce((n, s) => n + s.tokens!.input, 0),
        outputTokens: modelSteps.reduce((n, s) => n + s.tokens!.output + s.tokens!.thinking, 0),
        costUsd: result.listPriceUsd,
        steps: result.steps.map(toStep),
        proposal: result.proposal
          ? {
              action: result.proposal.action,
              payload: result.proposal.payload as Record<string, unknown>,
            }
          : null,
      });
      if (deps.collector) runs.saveTrace(run.id, deps.collector.take(result.traceId));
      queue.complete(job.id);
      return "done";
    } catch (err) {
      const message = (err as Error).message;
      const r = queue.fail(job.id, message);
      if (r.status === "dead") {
        runs.failRun(run.id, {
          error: message,
          attempts: job.attempts,
          promptHash: loadSystemPrompt().hash, // the prompt it would have used, for triage
        });
        return "dead";
      }
      return "retry";
    } finally {
      await tools?.close();
    }
  }

  /** Process every ready job, then stop. Returns how many were handled. */
  async function drain(): Promise<number> {
    let n = 0;
    while ((await processOne()) !== "idle") n++;
    return n;
  }

  /** Keep draining, sleeping `pollMs` when the queue is empty. */
  function start(pollMs = 1000) {
    let stopped = false;
    const loop = (async () => {
      while (!stopped) {
        if ((await processOne()) === "idle") await new Promise((r) => setTimeout(r, pollMs));
      }
    })();
    return { stop: async () => void ((stopped = true), await loop) };
  }

  return { processOne, drain, start };
}
