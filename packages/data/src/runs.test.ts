import { beforeEach, describe, expect, it } from "vitest";
import { createJobQueue } from "./queue.ts";
import { createRunStore, IdempotencyConflict, type CompletedRun, type RunStore } from "./runs.ts";
import { openDb, type Db } from "./sqlite/db.ts";
import { seed } from "../seed/seed.ts";

let db: Db;
let now: Date;
let runs: RunStore;
const clock = () => now;
const advance = (ms: number) => void (now = new Date(now.getTime() + ms));

beforeEach(() => {
  db = openDb(":memory:");
  seed(db);
  now = new Date("2026-11-20T06:00:00.000Z");
  runs = createRunStore(db, { now: clock });
});

const ticket = { tenantId: "tenant_a", channel: "email" as const, text: "Where is order A-10407?" };
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const done = (over: Partial<CompletedRun> = {}): CompletedRun => ({
  status: "awaiting_approval",
  decision: "AUTO_REPLY",
  decisionJson: { decision: "AUTO_REPLY" },
  inputTokens: 100,
  outputTokens: 20,
  costUsd: 0.001,
  steps: [
    { seq: 1, kind: "transition", name: "start → classify" },
    {
      seq: 2,
      kind: "tool_call",
      name: "get_order",
      input: { order_id: "A-10407" },
      output: { ok: true },
      durationMs: 4,
    },
  ],
  proposal: {
    action: "send_reply",
    payload: { body: "It ships soon.", clause_ids: ["delivery.estimates"] },
  },
  ...over,
});

describe("creating a run", () => {
  it("writes the ticket, the run and its job together", () => {
    const { run, created } = runs.createRun(ticket);
    expect(created).toBe(true);
    expect(run).toMatchObject({
      status: "queued",
      decision: null,
      ticket: { text: ticket.text, channel: "email" },
    });
    expect([count("tickets"), count("runs"), count("jobs")]).toEqual([1, 1, 1]);
  });

  it("an idempotent retry creates ONE run and returns the original", () => {
    const first = runs.createRun({ ...ticket, idempotencyKey: "k1" });
    const second = runs.createRun({ ...ticket, idempotencyKey: "k1" });
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect([count("runs"), count("jobs"), count("tickets")]).toEqual([1, 1, 1]);
  });

  it("the same key with a different ticket is refused, never silently reused", () => {
    runs.createRun({ ...ticket, idempotencyKey: "k1" });
    expect(() =>
      runs.createRun({ ...ticket, text: "something else", idempotencyKey: "k1" }),
    ).toThrow(IdempotencyConflict);
    expect(count("runs")).toBe(1);
  });

  it("two merchants may use the same key independently", () => {
    const a = runs.createRun({ ...ticket, idempotencyKey: "k1" });
    const b = runs.createRun({ ...ticket, tenantId: "tenant_b", idempotencyKey: "k1" });
    expect(b.created).toBe(true);
    expect(b.run.id).not.toBe(a.run.id);
  });
});

describe("live steps and the worker's view", () => {
  it("steps appended one by one survive completion with no duplicates", () => {
    const { run } = runs.createRun(ticket);
    runs.appendStep(run.id, { seq: 1, kind: "transition", name: "start → classify" });
    runs.appendStep(run.id, { seq: 1, kind: "transition", name: "start → classify" }); // repeated: ignored
    expect(runs.listSteps("tenant_a", run.id)).toHaveLength(1);
    runs.completeRun(run.id, done()); // carries seq 1 and 2 again
    expect(runs.listSteps("tenant_a", run.id)!.map((s) => s.seq)).toEqual([1, 2]);
  });

  it("findRun is the worker's lookup by ID alone; requests still use the scoped getRun", () => {
    const { run } = runs.createRun(ticket);
    expect(runs.findRun(run.id)!.tenantId).toBe("tenant_a");
    expect(runs.getRun("tenant_b", run.id)).toBeNull();
  });
});

describe("tenant scoping", () => {
  it("another merchant's run, steps and approvals are not found, exactly like a missing one", () => {
    const { run } = runs.createRun(ticket);
    runs.completeRun(run.id, done());
    const apr = runs.listApprovals("tenant_a")[0]!;
    expect(runs.getRun("tenant_b", run.id)).toBeNull();
    expect(runs.getRun("tenant_a", "run_nope")).toBeNull();
    expect(runs.listSteps("tenant_b", run.id)).toBeNull();
    expect(runs.listRuns("tenant_b")).toEqual([]);
    expect(runs.listApprovals("tenant_b")).toEqual([]);
    expect(runs.getApproval("tenant_b", apr.id)).toBeNull();
    expect(runs.decideApproval("tenant_b", apr.id, "approved", "rev")).toBeNull();
    expect(runs.getApproval("tenant_a", apr.id)!.status).toBe("pending"); // untouched
  });
});

describe("completing a run", () => {
  it("stores the steps and files the proposal as a pending approval", () => {
    const { run } = runs.createRun(ticket);
    expect(runs.completeRun(run.id, done())).toBe(true);
    const r = runs.getRun("tenant_a", run.id)!;
    expect(r).toMatchObject({
      status: "awaiting_approval",
      decision: "AUTO_REPLY",
      inputTokens: 100,
    });
    expect(runs.listSteps("tenant_a", run.id)!.map((s) => s.name)).toEqual([
      "start → classify",
      "get_order",
    ]);
    expect(runs.listApprovals("tenant_a", { status: "pending" })).toHaveLength(1);
  });

  it("a retried worker cannot complete a run twice or file a second approval", () => {
    const { run } = runs.createRun(ticket);
    expect(runs.completeRun(run.id, done())).toBe(true);
    expect(runs.completeRun(run.id, done())).toBe(false);
    expect([count("approvals"), count("run_steps")]).toEqual([1, 2]);
  });

  it("a REJECT has no proposal, so nothing waits for a human", () => {
    const { run } = runs.createRun(ticket);
    runs.completeRun(run.id, done({ status: "done", decision: "REJECT", proposal: null }));
    expect(runs.listApprovals("tenant_a")).toEqual([]);
    expect(runs.getRun("tenant_a", run.id)!.status).toBe("done");
  });
});

describe("approvals", () => {
  const filed = () => {
    const { run } = runs.createRun(ticket);
    runs.completeRun(run.id, done());
    return { run, apr: runs.listApprovals("tenant_a")[0]! };
  };

  it("an approval can be decided once", () => {
    const { apr } = filed();
    expect(runs.decideApproval("tenant_a", apr.id, "approved", "rev_1")).toMatchObject({
      status: "approved",
      reviewer: "rev_1",
    });
    expect(runs.decideApproval("tenant_a", apr.id, "rejected", "rev_2")).toBeNull();
    expect(runs.getApproval("tenant_a", apr.id)!.status).toBe("approved");
  });

  it("only an APPROVED record satisfies a write: pending and rejected do not", () => {
    const { run, apr } = filed();
    expect(runs.getApprovedApproval("tenant_a", run.id, "send_reply")).toBeNull(); // pending
    runs.decideApproval("tenant_a", apr.id, "rejected", "rev");
    expect(runs.getApprovedApproval("tenant_a", run.id, "send_reply")).toBeNull(); // rejected
    expect(runs.getRun("tenant_a", run.id)!.status).toBe("done"); // a rejection ends the run
  });

  it("an approved write is recorded once, however often it is requested, and then finishes the run", () => {
    const { run, apr } = filed();
    runs.decideApproval("tenant_a", apr.id, "approved", "rev");
    expect(runs.getRun("tenant_a", run.id)!.status).toBe("awaiting_approval"); // approved, not yet sent
    const approved = runs.getApprovedApproval("tenant_a", run.id, "send_reply")!;
    expect(runs.recordWrite(approved).created).toBe(true);
    expect(runs.recordWrite(approved).created).toBe(false);
    expect(runs.listOutbox("tenant_a")).toHaveLength(1);
    expect(runs.getRun("tenant_a", run.id)!.status).toBe("done");
  });
});

describe("the job queue", () => {
  const setup = (maxAttempts = 3) => {
    const queue = createJobQueue(db, { now: clock, backoffMs: (n) => n * 1000 });
    const { run } = runs.createRun({ ...ticket, maxAttempts });
    return { queue, run };
  };

  it("hands out a job once while it is leased", () => {
    const { queue, run } = setup();
    const job = queue.claim()!;
    expect(job).toMatchObject({ runId: run.id, attempts: 1, maxAttempts: 3 });
    expect(queue.claim()).toBeNull();
    queue.complete(job.id);
    expect(queue.stats()).toMatchObject({ done: 1, queued: 0, leased: 0 });
  });

  it("retries with backoff, then dead-letters when the attempts run out", () => {
    const { queue } = setup(3);
    let job = queue.claim()!;
    expect(queue.fail(job.id, "boom 1")).toMatchObject({ status: "queued" });
    expect(queue.claim()).toBeNull(); // backing off: not ready yet
    advance(1000);
    job = queue.claim()!;
    expect(job.attempts).toBe(2);
    expect(queue.fail(job.id, "boom 2")).toMatchObject({ status: "queued" });
    advance(2000);
    job = queue.claim()!;
    expect(job.attempts).toBe(3);
    expect(queue.fail(job.id, "boom 3")).toMatchObject({ status: "dead" });
    advance(60_000);
    expect(queue.claim()).toBeNull(); // dead jobs are never handed out again
    expect(queue.listDead()).toEqual([
      expect.objectContaining({ attempts: 3, lastError: "boom 3" }),
    ]);
    expect(queue.stats()).toMatchObject({ dead: 1, queued: 0 });
  });

  it("a worker that dies mid-job loses nothing: the lease expires and the job is claimed again", () => {
    const { queue, run } = setup();
    expect(queue.claim({ leaseMs: 5000 })!.runId).toBe(run.id);
    advance(4000);
    expect(queue.claim()).toBeNull(); // still leased
    advance(2000); // lease expired
    expect(queue.claim()!).toMatchObject({ runId: run.id, attempts: 2 });
  });

  it("a job that keeps killing its worker is dead-lettered, not retried forever", () => {
    const { queue } = setup(2);
    queue.claim({ leaseMs: 1000 });
    advance(2000);
    queue.claim({ leaseMs: 1000 }); // second and last attempt
    advance(2000);
    expect(queue.claim()).toBeNull();
    expect(queue.listDead()).toHaveLength(1);
    expect(queue.listDead()[0]!.lastError).toMatch(/worker died/);
  });
});
