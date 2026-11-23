import type { Db } from "./sqlite/db.ts";

/**
 * The job queue: a `jobs` table in the same SQLite file as the runs (DESIGN.md 3.1).
 *
 *   claim     takes the oldest ready job under a LEASE; if the worker dies, the lease expires and
 *             the job becomes claimable again instead of being lost
 *   fail      bounded retry with exponential backoff, then a DEAD-LETTER state for a human to look at
 *   complete  done
 *
 * Every claim counts as an attempt (including one that ends with a crashed worker), so a job that
 * keeps killing its worker is dead-lettered rather than retried forever.
 */
export interface Job {
  id: string;
  runId: string;
  attempts: number;
  maxAttempts: number;
  leaseUntil: string;
}

export interface JobQueue {
  claim(opts?: { leaseMs?: number }): Job | null;
  complete(jobId: string): void;
  /** Retry later, or dead-letter when the attempts are used up. */
  fail(
    jobId: string,
    error: string,
  ): { status: "queued" | "dead"; runAfter?: string; runId: string };
  stats(): { queued: number; leased: number; done: number; dead: number };
  listDead(): { id: string; runId: string; attempts: number; lastError: string | null }[];
}

interface JobRow {
  id: string;
  run_id: string;
  status: "queued" | "leased" | "done" | "dead";
  attempts: number;
  max_attempts: number;
  run_after: string;
  lease_until: string | null;
  last_error: string | null;
}

export const DEFAULT_LEASE_MS = 60_000;
export const defaultBackoffMs = (attempts: number) => Math.min(1000 * 2 ** attempts, 60_000);

export function createJobQueue(
  db: Db,
  options: { now?: () => Date; backoffMs?: (attempts: number) => number } = {},
): JobQueue {
  const clock = options.now ?? (() => new Date());
  const iso = (ms = 0) => new Date(clock().getTime() + ms).toISOString();
  const backoff = options.backoffMs ?? defaultBackoffMs;

  const q = {
    next: db.prepare(
      `SELECT * FROM jobs
       WHERE (status = 'queued' AND run_after <= ?) OR (status = 'leased' AND lease_until < ?)
       ORDER BY run_after, id LIMIT 1`,
    ),
    lease: db.prepare(
      "UPDATE jobs SET status = 'leased', attempts = attempts + 1, lease_until = ? WHERE id = ?",
    ),
    kill: db.prepare(
      "UPDATE jobs SET status = 'dead', lease_until = NULL, last_error = ? WHERE id = ?",
    ),
    done: db.prepare("UPDATE jobs SET status = 'done', lease_until = NULL WHERE id = ?"),
    one: db.prepare("SELECT * FROM jobs WHERE id = ?"),
    retry: db.prepare(
      "UPDATE jobs SET status = 'queued', run_after = ?, lease_until = NULL, last_error = ? WHERE id = ?",
    ),
    count: db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"),
    dead: db.prepare(
      "SELECT id, run_id, attempts, last_error FROM jobs WHERE status = 'dead' ORDER BY run_after, id",
    ),
  };

  return {
    claim(opts = {}) {
      return db.transaction(() => {
        for (;;) {
          const t = iso();
          const row = q.next.get(t, t) as JobRow | undefined;
          if (!row) return null;
          // A lease that expired with every attempt used: the worker keeps dying on this job.
          if (row.status === "leased" && row.attempts >= row.max_attempts) {
            q.kill.run("lease expired after the last attempt (the worker died)", row.id);
            continue;
          }
          const leaseUntil = iso(opts.leaseMs ?? DEFAULT_LEASE_MS);
          q.lease.run(leaseUntil, row.id);
          return {
            id: row.id,
            runId: row.run_id,
            attempts: row.attempts + 1,
            maxAttempts: row.max_attempts,
            leaseUntil,
          };
        }
      })();
    },
    complete(jobId) {
      q.done.run(jobId);
    },
    fail(jobId, error) {
      return db.transaction(() => {
        const row = q.one.get(jobId) as JobRow;
        if (row.attempts >= row.max_attempts) {
          q.kill.run(error, jobId);
          return { status: "dead" as const, runId: row.run_id };
        }
        const runAfter = iso(backoff(row.attempts));
        q.retry.run(runAfter, error, jobId);
        return { status: "queued" as const, runAfter, runId: row.run_id };
      })();
    },
    stats() {
      const out = { queued: 0, leased: 0, done: 0, dead: 0 };
      for (const r of q.count.all() as { status: keyof typeof out; n: number }[])
        out[r.status] = r.n;
      return out;
    },
    listDead() {
      return (
        q.dead.all() as {
          id: string;
          run_id: string;
          attempts: number;
          last_error: string | null;
        }[]
      ).map((r) => ({ id: r.id, runId: r.run_id, attempts: r.attempts, lastError: r.last_error }));
    },
  };
}
