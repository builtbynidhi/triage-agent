import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signToken } from "./auth.ts";
import {
  RETURN_TICKET,
  SECRET,
  reply,
  returnScript,
  scriptedRouter,
  startTestApi,
  type TestApi,
} from "./test-helpers.ts";

let t: TestApi;
beforeEach(async () => void (t = await startTestApi()));
afterEach(() => t.close());

const count = (table: string) => t.count(table);
const post = (who: Promise<string> | string | null, body: unknown = RETURN_TICKET, headers = {}) =>
  t.api("POST", "/v1/triage", who, body, headers);

describe("authentication", () => {
  it("refuses a request with no token, as a problem document", async () => {
    const r = await post(null);
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toMatch(/application\/problem\+json/);
    expect(r.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect(count("runs")).toBe(0);
  });

  it("refuses a forged, expired, unsigned or role-less token, all with the same answer", async () => {
    const who = { sub: "x", tenantId: "tenant_a", role: "reviewer" as const };
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const claims = {
      sub: "x",
      tenant: "tenant_a",
      role: "reviewer",
      iss: "triage-agent",
      aud: "triage-api",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const noRole = await new SignJWT({ tenant: "tenant_a" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("x")
      .setIssuer("triage-agent")
      .setAudience("triage-api")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    const bad = [
      "not.a.token",
      await signToken("y".repeat(48), who), // signed with another secret
      await signToken(SECRET, who, { ttlSeconds: 60, now: Date.now() - 3_600_000 }), // expired
      `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`, // alg: none
      noRole,
    ];
    const answers = await Promise.all(bad.map((token) => t.api("GET", "/v1/runs", token)));
    expect(answers.map((a) => a.status)).toEqual([401, 401, 401, 401, 401]);
    expect(new Set(answers.map((a) => a.text)).size).toBe(1); // no oracle: one message for every failure
  });

  it("refuses a valid token for a merchant that does not exist", async () => {
    const r = await t.api("GET", "/v1/runs", t.token("agent", "tenant_ghost"));
    expect(r.status).toBe(401);
  });
});

describe("POST /triage", () => {
  it("queues a ticket: 202 with a run ID and a Location, and one job", async () => {
    const r = await post(t.token("agent"));
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({
      status: "queued",
      replayed: false,
      run_id: expect.stringMatching(/^run_/),
    });
    expect(r.headers.get("location")).toBe(`/v1/runs/${r.json!.run_id}`);
    expect([count("runs"), count("jobs"), count("tickets")]).toEqual([1, 1, 1]);
  });

  it("also answers on the unversioned path the spec writes", async () => {
    const r = await t.api("POST", "/triage", t.token("agent"), RETURN_TICKET);
    expect(r.status).toBe(202);
  });

  it("an idempotent retry creates ONE run and says it is a replay", async () => {
    const first = await post(t.token("agent"), RETURN_TICKET, { "Idempotency-Key": "abc-123" });
    const retry = await post(t.token("agent"), RETURN_TICKET, { "Idempotency-Key": "abc-123" });
    expect(retry.status).toBe(202);
    expect(retry.json).toMatchObject({ run_id: first.json!.run_id, replayed: true });
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect([count("runs"), count("jobs")]).toEqual([1, 1]);
  });

  it("the same key with a different ticket is a 409, not a silent reuse", async () => {
    await post(t.token("agent"), RETURN_TICKET, { "Idempotency-Key": "k" });
    const r = await post(
      t.token("agent"),
      { ...RETURN_TICKET, text: "a different ticket" },
      { "Idempotency-Key": "k" },
    );
    expect(r.status).toBe(409);
    expect(count("runs")).toBe(1);
  });

  it("rejects bad input as a 400 problem and queues nothing", async () => {
    const cases: [unknown, Record<string, string>][] = [
      [{ text: "" }, {}],
      [{ text: "hi", channel: "carrier-pigeon" }, {}],
      [{ text: "hi", tenant_id: "tenant_b" }, {}], // the merchant is never taken from the body
      [{ text: "x".repeat(10_001) }, {}],
      ["{not json", {}],
      [RETURN_TICKET, { "Idempotency-Key": "has spaces" }],
    ];
    for (const [body, headers] of cases)
      expect(
        (await post(t.token("agent"), body, headers)).status,
        JSON.stringify(body).slice(0, 40),
      ).toBe(400);
    expect(count("runs")).toBe(0);
  });

  it("rate-limits per merchant: one noisy merchant cannot use up another's allowance", async () => {
    await t.close();
    t = await startTestApi({ capacity: 2, refillPerSec: 0.1 });
    expect((await post(t.token("agent"))).status).toBe(202);
    expect((await post(t.token("agent"))).status).toBe(202);
    const limited = await post(t.token("agent"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(t.token("agent", "tenant_b"))).status).toBe(202); // another merchant is unaffected
    t.clock.now = new Date(t.clock.now.getTime() + 20_000); // 20 s refills 2 tokens
    expect((await post(t.token("agent"))).status).toBe(202);
  });
});

describe("reading runs", () => {
  it("another merchant's run is a 404, identical to a missing one", async () => {
    const { run_id } = (await post(t.token("agent"))).json as { run_id: string };
    const theirs = await t.api("GET", `/v1/runs/${run_id}`, t.token("agent", "tenant_b"));
    const missing = await t.api("GET", "/v1/runs/run_nope", t.token("agent", "tenant_b"));
    expect(theirs.status).toBe(404);
    expect(theirs.text).toBe(missing.text);
    expect((await t.api("GET", "/v1/runs", t.token("agent", "tenant_b"))).json!.runs).toEqual([]);
    expect((await t.api("GET", "/v1/runs", t.token("agent"))).json!.runs).toHaveLength(1);
    expect(
      (await t.api("GET", `/v1/runs/${run_id}/stream`, t.token("agent", "tenant_b"))).status,
    ).toBe(404);
  });
});

describe("a ticket posted over HTTP reaches a decision and waits for approval (the Phase 10 done-when)", () => {
  const submit = async () => ((await post(t.token("agent"))).json as { run_id: string }).run_id;

  it("end to end: queued, worked, awaiting a reviewer, approved, written once", async () => {
    const run_id = await submit();
    expect((await t.api("GET", `/v1/runs/${run_id}`, t.token("agent"))).json).toMatchObject({
      status: "queued",
      decision: null,
    });

    expect(await t.worker(scriptedRouter(returnScript())).drain()).toBe(1);

    const run = (await t.api("GET", `/v1/runs/${run_id}`, t.token("agent"))).json!;
    expect(run).toMatchObject({ status: "awaiting_approval", decision: "AUTO_REPLY" });
    expect(run.result).toMatchObject({ clause_ids: ["returns.window"], exit: "decided" });
    expect(run.steps.map((s: { name: string }) => s.name)).toEqual(
      expect.arrayContaining(["search_policy", "get_order", "check_eligibility", "decide"]),
    );
    expect(run.usage.input_tokens).toBeGreaterThan(0);
    expect(run.approvals).toEqual([
      expect.objectContaining({ action: "send_reply", status: "pending" }),
    ]);
    expect(t.runs.listOutbox("tenant_a")).toEqual([]); // nothing has been sent: it is waiting

    const queue = await t.api("GET", "/v1/approvals", t.token("reviewer"));
    expect(queue.json!.approvals).toHaveLength(1);
    const approvalId = queue.json!.approvals[0].id as string;

    const ok = await t.api("POST", `/v1/approvals/${approvalId}/approve`, t.token("reviewer"));
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      approval: { status: "approved", reviewer: "reviewer_1" },
      write: { ok: true, already_recorded: false },
    });
    expect(t.runs.listOutbox("tenant_a")).toHaveLength(1);
    expect((await t.api("GET", `/v1/runs/${run_id}`, t.token("agent"))).json).toMatchObject({
      status: "done",
    });

    // Approving again is safe: the write is recorded once per approval.
    const again = await t.api("POST", `/v1/approvals/${approvalId}/approve`, t.token("reviewer"));
    expect(again.json).toMatchObject({ write: { already_recorded: true } });
    expect(t.runs.listOutbox("tenant_a")).toHaveLength(1);
    // A decided approval cannot be flipped.
    expect(
      (await t.api("POST", `/v1/approvals/${approvalId}/reject`, t.token("reviewer"))).status,
    ).toBe(409);
  });

  it("a non-reviewer cannot see the queue or approve, and nothing changes", async () => {
    await submit();
    await t.worker(scriptedRouter(returnScript())).drain();
    const id = t.runs.listApprovals("tenant_a")[0]!.id;
    expect((await t.api("GET", "/v1/approvals", t.token("agent"))).status).toBe(403);
    expect((await t.api("POST", `/v1/approvals/${id}/approve`, t.token("agent"))).status).toBe(403);
    expect((await t.api("POST", `/v1/approvals/${id}/reject`, t.token("agent"))).status).toBe(403);
    expect(t.runs.getApproval("tenant_a", id)!.status).toBe("pending");
    expect(t.runs.listOutbox("tenant_a")).toEqual([]);
  });

  it("a reviewer from another merchant cannot approve this merchant's proposal", async () => {
    await submit();
    await t.worker(scriptedRouter(returnScript())).drain();
    const id = t.runs.listApprovals("tenant_a")[0]!.id;
    expect(
      (await t.api("POST", `/v1/approvals/${id}/approve`, t.token("reviewer", "tenant_b"))).status,
    ).toBe(404);
    expect(t.runs.getApproval("tenant_a", id)!.status).toBe("pending");
  });

  it("a rejection ends the run and nothing is ever sent", async () => {
    const run_id = await submit();
    await t.worker(scriptedRouter(returnScript())).drain();
    const id = t.runs.listApprovals("tenant_a")[0]!.id;
    expect(
      (await t.api("POST", `/v1/approvals/${id}/reject`, t.token("reviewer"))).json,
    ).toMatchObject({ approval: { status: "rejected" } });
    expect((await t.api("GET", `/v1/runs/${run_id}`, t.token("agent"))).json).toMatchObject({
      status: "done",
    });
    expect((await t.api("POST", `/v1/approvals/${id}/approve`, t.token("reviewer"))).status).toBe(
      409,
    );
    expect(t.runs.listOutbox("tenant_a")).toEqual([]);
  });

  it("a REJECT decision has nothing to approve: the run is simply done", async () => {
    const run_id = await submit();
    await t
      .worker(
        scriptedRouter([
          reply({ text: "DONE" }),
          reply({
            text: JSON.stringify({
              decision: "REJECT",
              intent: "other",
              confidence: 0.9,
              facts_used: [],
              clause_ids: [],
              reply_draft: "",
              escalation_reason: "",
              missing_fields: [],
            }),
          }),
        ]),
      )
      .drain();
    expect((await t.api("GET", `/v1/runs/${run_id}`, t.token("agent"))).json).toMatchObject({
      status: "done",
      decision: "REJECT",
      approvals: [],
    });
  });
});

describe("the queue under failure", () => {
  it("retries a failing job with backoff, then dead-letters it and marks the run failed with the reason", async () => {
    const { run_id } = (await post(t.token("agent"))).json as { run_id: string };
    const down = scriptedRouter([
      new Error("model down"),
      new Error("model down"),
      new Error("model down"),
      new Error("model down"),
    ]);
    const w = t.worker(down);
    expect(await w.processOne()).toBe("retry");
    expect(await w.processOne()).toBe("idle"); // backing off
    t.clock.now = new Date(t.clock.now.getTime() + 1500);
    expect(await w.processOne()).toBe("retry");
    t.clock.now = new Date(t.clock.now.getTime() + 2500);
    expect(await w.processOne()).toBe("dead");
    const run = (await t.api("GET", `/v1/runs/${run_id}`, t.token("agent"))).json!;
    expect(run).toMatchObject({
      status: "failed",
      failure: { error: expect.stringContaining("model down"), attempts: 3 },
    });
    expect(t.queue.listDead()).toHaveLength(1);
    expect(t.runs.listApprovals("tenant_a")).toEqual([]); // a failed run proposes nothing
  });

  it("a job that fails once and then succeeds completes normally, with a clean trace", async () => {
    const { run_id } = (await post(t.token("agent"))).json as { run_id: string };
    const w = t.worker(scriptedRouter([new Error("blip"), ...returnScript()]));
    expect(await w.processOne()).toBe("retry");
    t.clock.now = new Date(t.clock.now.getTime() + 1500);
    expect(await w.processOne()).toBe("done");
    const run = (await t.api("GET", `/v1/runs/${run_id}`, t.token("agent"))).json!;
    expect(run.status).toBe("awaiting_approval");
    const seqs = run.steps.map((s: { seq: number }) => s.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicate steps from the failed attempt
  });
});

describe("GET /runs/:id/stream", () => {
  async function events(
    path: string,
    who: Promise<string>,
    then: () => Promise<unknown>,
  ): Promise<string[]> {
    const res = await fetch(`${t.base}${path}`, {
      headers: { Authorization: `Bearer ${await who}` },
    });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const done = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value);
      }
    })();
    await then();
    await done;
    return [...buf.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map((m) => `${m[1]} ${m[2]}`);
  }

  it("streams the status and the trace, then ends when the run settles", async () => {
    const { run_id } = (await post(t.token("agent"))).json as { run_id: string };
    const lines = await events(`/v1/runs/${run_id}/stream`, t.token("agent"), async () => {
      await new Promise((r) => setTimeout(r, 40));
      await t.worker(scriptedRouter(returnScript())).drain();
    });
    expect(lines[0]).toMatch(/^status .*"queued"/);
    expect(lines.some((l) => l.startsWith("step ") && l.includes("get_order"))).toBe(true);
    expect(lines.some((l) => l.startsWith("status ") && l.includes("awaiting_approval"))).toBe(
      true,
    );
    expect(lines.at(-1)).toMatch(/^end .*awaiting_approval/);
  });

  it("caps open streams per merchant", async () => {
    await t.close();
    t = await startTestApi({ maxStreams: 1 });
    const { run_id } = (await post(t.token("agent"))).json as { run_id: string };
    const first = await fetch(`${t.base}/v1/runs/${run_id}/stream`, {
      headers: { Authorization: `Bearer ${await t.token("agent")}` },
    });
    expect((await t.api("GET", `/v1/runs/${run_id}/stream`, t.token("agent"))).status).toBe(429);
    await first.body!.cancel();
  });
});
