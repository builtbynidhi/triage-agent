import {
  IdempotencyConflict,
  type ApprovalRecord,
  type RunRecord,
  type RunStore,
  type TriageStore,
} from "@triage/data";
import { createEscalation, createToolContext, invokeTool, sendReply } from "@triage/mcp-server";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { authenticate, principalOf, requireRole } from "./auth.ts";
import { problem } from "./problem.ts";
import { rateLimit, type RateLimiter } from "./rate-limit.ts";

/**
 * The HTTP API. It only ever does three things: queue a ticket, show what happened to it, and let
 * a reviewer approve or reject what the agent proposed. It never runs the agent (the worker does)
 * and never writes except through the approval-gated tools.
 *
 *   POST /v1/triage                    agent|reviewer   queue a ticket, 202 with a run ID
 *   GET  /v1/runs                      agent|reviewer   this merchant's runs, newest first
 *   GET  /v1/runs/:id                  agent|reviewer   one run with its trace and approvals
 *   GET  /v1/runs/:id/stream           agent|reviewer   Server-Sent Events until the run settles
 *   GET  /v1/approvals?status=         reviewer         the approval queue (default: pending)
 *   POST /v1/approvals/:id/approve     reviewer         approve, then perform the write
 *   POST /v1/approvals/:id/reject      reviewer         reject
 *
 * The same routes also answer without the /v1 prefix, as the spec writes them.
 */
export interface AppDeps {
  store: TriageStore;
  runs: RunStore;
  jwtSecret: string;
  limiter: RateLimiter;
  /** Pin "today" (YYYY-MM-DD) for the tools an approval runs; default is today in India. */
  today?: string;
  /** How often the SSE stream looks for news. */
  pollMs?: number;
  maxStreamsPerTenant?: number;
}

const TriageBody = z
  .object({
    text: z.string().trim().min(1).max(10_000),
    channel: z.enum(["email", "chat", "web", "voice"]).default("web"),
    order_id: z.string().trim().max(20).optional(),
  })
  .strict();

const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,128}$/;
const SETTLED = new Set(["awaiting_approval", "done", "failed"]);

const runView = (r: RunRecord) => ({
  id: r.id,
  status: r.status,
  decision: r.decision,
  ticket: { channel: r.ticket.channel, text: r.ticket.text, order_id: r.ticket.orderId },
  usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens, cost_usd: r.costUsd },
  latency_ms: Math.round(r.latencyMs),
  failure: r.failure,
  created_at: r.createdAt,
  finished_at: r.finishedAt,
});

const approvalView = (a: ApprovalRecord) => ({
  id: a.id,
  run_id: a.runId,
  action: a.action,
  status: a.status,
  payload: a.payload,
  reviewer: a.reviewer,
  created_at: a.createdAt,
  decided_at: a.decidedAt,
});

export function createApp(deps: AppDeps): Express {
  const { store, runs } = deps;
  const app = express();
  app.disable("x-powered-by");
  const streams = new Map<string, number>();
  const maxStreams = deps.maxStreamsPerTenant ?? 10;

  const router = express.Router();
  router.use(authenticate(deps.jwtSecret, store));
  const anyRole = requireRole("agent", "reviewer");
  const reviewerOnly = requireRole("reviewer");

  router.post("/triage", anyRole, rateLimit(deps.limiter), (req: Request, res: Response) => {
    const body = TriageBody.safeParse(req.body ?? {});
    if (!body.success) {
      return problem(
        res,
        400,
        "Invalid ticket",
        body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      );
    }
    const key = req.header("idempotency-key");
    if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
      return problem(res, 400, "Invalid Idempotency-Key", "Use 1 to 128 printable characters.");
    }
    try {
      const { run, created } = runs.createRun({
        tenantId: principalOf(res).tenantId,
        channel: body.data.channel,
        text: body.data.text,
        ...(body.data.order_id ? { orderId: body.data.order_id } : {}),
        ...(key ? { idempotencyKey: key } : {}),
      });
      res
        .status(202)
        .set("Location", `/v1/runs/${run.id}`)
        .set("Idempotent-Replayed", String(!created))
        .json({ run_id: run.id, status: run.status, replayed: !created });
    } catch (err) {
      if (err instanceof IdempotencyConflict) {
        return problem(res, 409, "Idempotency key reused", err.message);
      }
      throw err;
    }
  });

  router.get("/runs", anyRole, (req: Request, res: Response) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({
      runs: runs
        .listRuns(principalOf(res).tenantId, { limit: Number.isFinite(limit) ? limit : 50 })
        .map(runView),
    });
  });

  router.get("/runs/:id", anyRole, (req: Request, res: Response) => {
    const tenantId = principalOf(res).tenantId;
    const run = runs.getRun(tenantId, req.params.id as string);
    if (!run) return problem(res, 404, "Not found", "No run with that ID.");
    res.json({
      ...runView(run),
      result: run.decisionJson,
      steps: runs.listSteps(tenantId, run.id),
      trace: runs.getTrace(tenantId, run.id) ?? [],
      approvals: runs
        .listApprovals(tenantId)
        .filter((a) => a.runId === run.id)
        .map(approvalView),
    });
  });

  router.get("/runs/:id/stream", anyRole, (req: Request, res: Response) => {
    const tenantId = principalOf(res).tenantId;
    const runId = req.params.id as string;
    if (!runs.getRun(tenantId, runId))
      return problem(res, 404, "Not found", "No run with that ID.");
    if ((streams.get(tenantId) ?? 0) >= maxStreams) {
      return problem(res, 429, "Too many streams", "Close one before opening another.");
    }
    streams.set(tenantId, (streams.get(tenantId) ?? 0) + 1);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let seenSteps = 0;
    let lastStatus = "";
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      streams.set(tenantId, Math.max(0, (streams.get(tenantId) ?? 1) - 1));
      res.end();
    };
    const tick = () => {
      const run = runs.getRun(tenantId, runId);
      if (!run) return close();
      const steps = runs.listSteps(tenantId, runId) ?? [];
      for (const s of steps.slice(seenSteps))
        send("step", { seq: s.seq, kind: s.kind, name: s.name, duration_ms: s.durationMs ?? null });
      seenSteps = steps.length;
      if (run.status !== lastStatus) {
        lastStatus = run.status;
        send("status", { status: run.status, decision: run.decision });
      }
      if (SETTLED.has(run.status)) {
        send("end", { status: run.status });
        close();
      }
    };
    const timer = setInterval(tick, deps.pollMs ?? 500);
    req.on("close", close);
    tick();
  });

  router.get("/approvals", reviewerOnly, (req: Request, res: Response) => {
    const status = z
      .enum(["pending", "approved", "rejected"])
      .safeParse(req.query.status ?? "pending");
    if (!status.success)
      return problem(res, 400, "Invalid status", "Use pending, approved or rejected.");
    res.json({
      approvals: runs
        .listApprovals(principalOf(res).tenantId, { status: status.data })
        .map(approvalView),
    });
  });

  /** Perform the write an approval allows. The tool re-checks the approval itself. */
  async function perform(tenantId: string, a: ApprovalRecord) {
    const ctx = await createToolContext({
      store,
      tenantId,
      runs,
      ...(deps.today ? { today: deps.today } : {}),
    });
    return a.action === "send_reply"
      ? invokeTool(
          sendReply,
          { run_id: a.runId, body: a.payload.body, clause_ids: a.payload.clause_ids },
          ctx,
        )
      : invokeTool(
          createEscalation,
          {
            run_id: a.runId,
            reason: a.payload.reason,
            summary: a.payload.summary,
            priority: a.payload.priority ?? "normal",
          },
          ctx,
        );
  }

  router.post("/approvals/:id/approve", reviewerOnly, async (req: Request, res: Response) => {
    const { tenantId, sub } = principalOf(res);
    let a = runs.getApproval(tenantId, req.params.id as string);
    if (!a) return problem(res, 404, "Not found", "No approval with that ID.");
    if (a.status === "rejected")
      return problem(res, 409, "Already rejected", "A rejected approval cannot be approved.");
    if (a.status === "pending") {
      a = runs.decideApproval(tenantId, a.id, "approved", sub);
      if (!a) return problem(res, 409, "Already decided", "Someone decided this approval first.");
    }
    // Approving again re-runs the write, which is safe: it is recorded once per approval.
    const out = await perform(tenantId, a);
    if (out.isError) {
      return problem(
        res,
        502,
        "Approved, but the write failed",
        (out.structuredContent as { message: string }).message,
      );
    }
    res.json({ approval: approvalView(a), write: out.structuredContent });
  });

  router.post("/approvals/:id/reject", reviewerOnly, (req: Request, res: Response) => {
    const { tenantId, sub } = principalOf(res);
    const a = runs.getApproval(tenantId, req.params.id as string);
    if (!a) return problem(res, 404, "Not found", "No approval with that ID.");
    const decided = runs.decideApproval(tenantId, a.id, "rejected", sub);
    if (!decided)
      return problem(res, 409, "Already decided", `This approval is already ${a.status}.`);
    res.json({ approval: approvalView(decided) });
  });

  app.use(express.json({ limit: "32kb" }));
  app.get("/healthz", (_req, res) => void res.json({ ok: true }));
  app.use("/v1", router);
  app.use(router);
  app.use((_req, res) => problem(res, 404, "Not found"));
  // Express recognises an error handler by its four parameters, so `_next` must stay.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed") return problem(res, 400, "Invalid JSON");
    if (err.type === "entity.too.large") return problem(res, 413, "Ticket too large");
    console.error("[api] unhandled error:", err);
    problem(res, 500, "Internal error"); // no detail: nothing internal leaves the server
  });
  return app;
}
