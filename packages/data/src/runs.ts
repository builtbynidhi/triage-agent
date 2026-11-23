import { randomUUID } from "node:crypto";
import type { Db } from "./sqlite/db.ts";

/**
 * Runs, approvals and the outbox: everything the API and the worker persist about a ticket.
 *
 * Tenant scoping is part of the contract, exactly as for orders: every read takes the tenant ID
 * and returns null for a record owned by another tenant, so a caller can never tell "missing"
 * from "someone else's".
 *
 * A run, its ticket and its job are written in ONE transaction, so "run exists" and "job exists"
 * can never disagree (the reason the queue lives in the same SQLite file, DESIGN.md 3.1).
 */
export type RunStatus = "queued" | "running" | "awaiting_approval" | "done" | "failed";
export type WriteAction = "create_escalation" | "send_reply";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface RunRecord {
  id: string;
  tenantId: string;
  status: RunStatus;
  decision: string | null;
  decisionJson: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  failure: unknown;
  createdAt: string;
  finishedAt: string | null;
  ticket: { id: string; channel: string; text: string; orderId: string | null };
}

export interface StepInput {
  seq: number;
  kind: "transition" | "model_call" | "tool_call" | "validation";
  name: string;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
}

export interface StepRecord extends StepInput {
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  tenantId: string;
  action: WriteAction;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  reviewer: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface OutboxRecord {
  id: string;
  approvalId: string;
  runId: string;
  tenantId: string;
  action: WriteAction;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** The same idempotency key was sent with a different ticket: refuse, never silently reuse. */
export class IdempotencyConflict extends Error {
  constructor() {
    super("That idempotency key was already used for a different ticket.");
    this.name = "IdempotencyConflict";
  }
}

export interface NewRun {
  tenantId: string;
  channel: "email" | "chat" | "web" | "voice";
  text: string;
  orderId?: string;
  idempotencyKey?: string;
  maxAttempts?: number;
}

export interface CompletedRun {
  status: "awaiting_approval" | "done";
  decision: string;
  decisionJson: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  steps: StepInput[];
  /** The write the agent proposes; filed as a pending approval. Null for REJECT. */
  proposal: { action: WriteAction; payload: Record<string, unknown> } | null;
}

export interface RunStore {
  /** Atomically creates the ticket, the run and its job. A repeated idempotency key returns the original run. */
  createRun(input: NewRun): { run: RunRecord; created: boolean };
  getRun(tenantId: string, runId: string): RunRecord | null;
  /** Newest first. */
  listRuns(tenantId: string, opts?: { limit?: number }): RunRecord[];
  listSteps(tenantId: string, runId: string): StepRecord[] | null;
  markRunning(runId: string): void;
  /** Idempotent: a run that is no longer queued or running is left as it is. Returns whether it changed. */
  completeRun(runId: string, result: CompletedRun): boolean;
  failRun(runId: string, failure: unknown): boolean;

  listApprovals(tenantId: string, opts?: { status?: ApprovalStatus }): ApprovalRecord[];
  getApproval(tenantId: string, approvalId: string): ApprovalRecord | null;
  /** The approved record for this run and action, or null: the one question a write tool asks. */
  getApprovedApproval(tenantId: string, runId: string, action: WriteAction): ApprovalRecord | null;
  /** pending → approved or rejected. Returns null if it is not pending (already decided) or not this tenant's. */
  decideApproval(
    tenantId: string,
    approvalId: string,
    decision: "approved" | "rejected",
    reviewer: string,
  ): ApprovalRecord | null;
  /** Record a write that happened. One per approval: repeating it returns the existing record. */
  recordWrite(approval: ApprovalRecord): { record: OutboxRecord; created: boolean };
  listOutbox(tenantId: string): OutboxRecord[];
}

interface RunRow {
  id: string;
  tenant_id: string;
  ticket_id: string;
  status: RunStatus;
  decision: string | null;
  decision_json: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  failure_json: string | null;
  created_at: string;
  finished_at: string | null;
  t_channel: string;
  t_text: string;
  t_order_id: string | null;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  tenant_id: string;
  action: WriteAction;
  payload_json: string;
  status: ApprovalStatus;
  reviewer: string | null;
  created_at: string;
  decided_at: string | null;
}

const json = (v: string | null) => (v === null ? null : (JSON.parse(v) as unknown));

const toRun = (r: RunRow): RunRecord => ({
  id: r.id,
  tenantId: r.tenant_id,
  status: r.status,
  decision: r.decision,
  decisionJson: json(r.decision_json),
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  costUsd: r.cost_usd,
  failure: json(r.failure_json),
  createdAt: r.created_at,
  finishedAt: r.finished_at,
  ticket: { id: r.ticket_id, channel: r.t_channel, text: r.t_text, orderId: r.t_order_id },
});

const toApproval = (r: ApprovalRow): ApprovalRecord => ({
  id: r.id,
  runId: r.run_id,
  tenantId: r.tenant_id,
  action: r.action,
  payload: JSON.parse(r.payload_json) as Record<string, unknown>,
  status: r.status,
  reviewer: r.reviewer,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export function createRunStore(db: Db, options: { now?: () => Date } = {}): RunStore {
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  const RUN_SELECT = `SELECT r.*, t.channel AS t_channel, t.text AS t_text, t.order_id AS t_order_id
                      FROM runs r JOIN tickets t ON t.id = r.ticket_id`;
  const q = {
    byKey: db.prepare(`${RUN_SELECT} WHERE r.tenant_id = ? AND r.idempotency_key = ?`),
    run: db.prepare(`${RUN_SELECT} WHERE r.tenant_id = ? AND r.id = ?`),
    runAny: db.prepare(`${RUN_SELECT} WHERE r.id = ?`),
    list: db.prepare(
      `${RUN_SELECT} WHERE r.tenant_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    ),
    insTicket: db.prepare(
      "INSERT INTO tickets (id, tenant_id, channel, text, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    insRun: db.prepare(
      "INSERT INTO runs (id, tenant_id, ticket_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)",
    ),
    insJob: db.prepare(
      "INSERT INTO jobs (id, run_id, status, attempts, max_attempts, run_after) VALUES (?, ?, 'queued', 0, ?, ?)",
    ),
    steps: db.prepare(
      "SELECT seq, kind, name, input_json, output_json, duration_ms, created_at FROM run_steps WHERE run_id = ? ORDER BY seq",
    ),
    insStep: db.prepare(
      "INSERT INTO run_steps (run_id, seq, kind, name, input_json, output_json, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    running: db.prepare("UPDATE runs SET status = 'running' WHERE id = ? AND status = 'queued'"),
    complete: db.prepare(
      `UPDATE runs SET status = ?, decision = ?, decision_json = ?, input_tokens = ?, output_tokens = ?,
              cost_usd = ?, finished_at = ? WHERE id = ? AND status IN ('queued','running')`,
    ),
    fail: db.prepare(
      "UPDATE runs SET status = 'failed', failure_json = ?, finished_at = ? WHERE id = ? AND status IN ('queued','running')",
    ),
    insApproval: db.prepare(
      "INSERT OR IGNORE INTO approvals (id, run_id, action, payload_json, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    ),
    approvals: db.prepare(
      `SELECT a.*, r.tenant_id FROM approvals a JOIN runs r ON r.id = a.run_id
       WHERE r.tenant_id = ? AND (? IS NULL OR a.status = ?) ORDER BY a.created_at DESC, a.id DESC`,
    ),
    approval: db.prepare(
      "SELECT a.*, r.tenant_id FROM approvals a JOIN runs r ON r.id = a.run_id WHERE r.tenant_id = ? AND a.id = ?",
    ),
    approvedFor: db.prepare(
      `SELECT a.*, r.tenant_id FROM approvals a JOIN runs r ON r.id = a.run_id
       WHERE r.tenant_id = ? AND a.run_id = ? AND a.action = ? AND a.status = 'approved'`,
    ),
    decide: db.prepare(
      "UPDATE approvals SET status = ?, reviewer = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
    ),
    runDone: db.prepare(
      "UPDATE runs SET status = 'done' WHERE id = ? AND status = 'awaiting_approval'",
    ),
    outboxFor: db.prepare("SELECT * FROM outbox WHERE approval_id = ?"),
    insOutbox: db.prepare(
      "INSERT INTO outbox (id, approval_id, run_id, tenant_id, action, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
    outboxList: db.prepare(
      "SELECT * FROM outbox WHERE tenant_id = ? ORDER BY created_at DESC, id DESC",
    ),
  };

  const toOutbox = (r: Record<string, string>): OutboxRecord => ({
    id: r.id!,
    approvalId: r.approval_id!,
    runId: r.run_id!,
    tenantId: r.tenant_id!,
    action: r.action as WriteAction,
    payload: JSON.parse(r.payload_json!) as Record<string, unknown>,
    createdAt: r.created_at!,
  });

  const store: RunStore = {
    createRun(input) {
      return db.transaction(() => {
        if (input.idempotencyKey) {
          const existing = q.byKey.get(input.tenantId, input.idempotencyKey) as RunRow | undefined;
          if (existing) {
            if (existing.t_text !== input.text) throw new IdempotencyConflict();
            return { run: toRun(existing), created: false };
          }
        }
        const ticketId = id("tk");
        const runId = id("run");
        const t = now();
        q.insTicket.run(
          ticketId,
          input.tenantId,
          input.channel,
          input.text,
          input.orderId ?? null,
          t,
        );
        q.insRun.run(runId, input.tenantId, ticketId, input.idempotencyKey ?? null, t);
        q.insJob.run(id("job"), runId, input.maxAttempts ?? 3, t);
        return { run: toRun(q.run.get(input.tenantId, runId) as RunRow), created: true };
      })();
    },
    getRun(tenantId, runId) {
      const r = q.run.get(tenantId, runId) as RunRow | undefined;
      return r ? toRun(r) : null;
    },
    listRuns(tenantId, opts = {}) {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      return (q.list.all(tenantId, limit) as RunRow[]).map(toRun);
    },
    listSteps(tenantId, runId) {
      if (!store.getRun(tenantId, runId)) return null;
      return (q.steps.all(runId) as Record<string, string | number | null>[]).map((s) => ({
        seq: s.seq as number,
        kind: s.kind as StepInput["kind"],
        name: s.name as string,
        input: json(s.input_json as string | null) ?? undefined,
        output: json(s.output_json as string | null) ?? undefined,
        durationMs: (s.duration_ms as number | null) ?? undefined,
        createdAt: s.created_at as string,
      }));
    },
    markRunning(runId) {
      q.running.run(runId);
    },
    completeRun(runId, r) {
      return db.transaction(() => {
        const t = now();
        const changed = q.complete.run(
          r.status,
          r.decision,
          JSON.stringify(r.decisionJson),
          r.inputTokens,
          r.outputTokens,
          r.costUsd,
          t,
          runId,
        ).changes;
        if (!changed) return false; // already completed (a retried job): nothing to write twice
        for (const s of r.steps) {
          q.insStep.run(
            runId,
            s.seq,
            s.kind,
            s.name,
            s.input === undefined ? null : JSON.stringify(s.input),
            s.output === undefined ? null : JSON.stringify(s.output),
            s.durationMs ?? null,
            t,
          );
        }
        if (r.proposal) {
          q.insApproval.run(
            id("apr"),
            runId,
            r.proposal.action,
            JSON.stringify(r.proposal.payload),
            t,
          );
        }
        return true;
      })();
    },
    failRun(runId, failure) {
      return q.fail.run(JSON.stringify(failure), now(), runId).changes > 0;
    },

    listApprovals(tenantId, opts = {}) {
      const status = opts.status ?? null;
      return (q.approvals.all(tenantId, status, status) as ApprovalRow[]).map(toApproval);
    },
    getApproval(tenantId, approvalId) {
      const r = q.approval.get(tenantId, approvalId) as ApprovalRow | undefined;
      return r ? toApproval(r) : null;
    },
    getApprovedApproval(tenantId, runId, action) {
      const r = q.approvedFor.get(tenantId, runId, action) as ApprovalRow | undefined;
      return r ? toApproval(r) : null;
    },
    decideApproval(tenantId, approvalId, decision, reviewer) {
      return db.transaction(() => {
        if (!store.getApproval(tenantId, approvalId)) return null;
        if (!q.decide.run(decision, reviewer, now(), approvalId).changes) return null;
        const a = store.getApproval(tenantId, approvalId)!;
        // A rejection ends the run now; an approval ends it when the write has actually happened.
        if (decision === "rejected") q.runDone.run(a.runId);
        return a;
      })();
    },
    recordWrite(approval) {
      return db.transaction(() => {
        const existing = q.outboxFor.get(approval.id) as Record<string, string> | undefined;
        if (existing) return { record: toOutbox(existing), created: false };
        const oid = id("out");
        q.insOutbox.run(
          oid,
          approval.id,
          approval.runId,
          approval.tenantId,
          approval.action,
          JSON.stringify(approval.payload),
          now(),
        );
        q.runDone.run(approval.runId);
        return {
          record: toOutbox(q.outboxFor.get(approval.id) as Record<string, string>),
          created: true,
        };
      })();
    },
    listOutbox(tenantId) {
      return (q.outboxList.all(tenantId) as Record<string, string>[]).map(toOutbox);
    },
  };
  return store;
}
