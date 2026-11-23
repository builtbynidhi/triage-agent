import { describe, expect, it } from "vitest";
import snapshotJson from "../data/snapshot.json";
import { buildSpanTree } from "./spans";
import type { Snapshot } from "./types";

/**
 * The public demo is only worth showing if its data is real, populated and safe. These tests guard
 * the committed snapshot (rebuild it with `pnpm web:snapshot`).
 */
const snap = snapshotJson as unknown as Snapshot;

describe("the demo snapshot", () => {
  it("is populated: at least 20 completed runs (the spec's bar), each with a trace and steps", () => {
    expect(snap.runs.length).toBeGreaterThanOrEqual(20);
    for (const r of snap.runs) {
      expect(["awaiting_approval", "done"], r.id).toContain(r.status);
      expect(r.steps.length, r.id).toBeGreaterThan(0);
      expect(buildSpanTree(r.trace).root, r.id).not.toBeNull();
    }
  });

  it("covers every decision, so the viewer shows each kind of outcome", () => {
    expect(new Set(snap.runs.map((r) => r.decision))).toEqual(
      new Set(["AUTO_REPLY", "NEEDS_INFO", "ESCALATE", "REJECT"]),
    );
  });

  it("each run's trace follows the GenAI shape: one invoke_agent root, chat and execute_tool children", () => {
    for (const r of snap.runs.filter((x) => x.steps.some((s) => s.kind === "model_call"))) {
      const ops = r.trace.map((s) => s.attributes["gen_ai.operation.name"]);
      expect(
        ops.filter((o) => o === "invoke_agent"),
        r.id,
      ).toHaveLength(1);
      expect(ops, r.id).toContain("chat");
      const root = r.trace.find((s) => s.parent_span_id === null)!;
      expect(
        r.trace
          .filter((s) => s.parent_span_id !== null)
          .every((s) => s.parent_span_id === root.span_id),
      ).toBe(true);
    }
  });

  it("holds no prompts or tool content in its spans, and no key-shaped strings anywhere", () => {
    const json = JSON.stringify(snap);
    for (const key of [
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "gen_ai.system_instructions",
      "gen_ai.tool.call.arguments",
      "gen_ai.tool.call.result",
    ]) {
      expect(json, key).not.toContain(key);
    }
    expect(json).not.toMatch(
      /gsk_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
    );
  });

  it("is read-only data: every approval is still pending (no human decision is invented)", () => {
    const approvals = snap.runs.flatMap((r) => r.approvals);
    expect(approvals.length).toBeGreaterThan(10);
    expect(approvals.every((a) => a.status === "pending" && a.reviewer === null)).toBe(true);
  });

  it("is honest about what it leaves out", () => {
    expect(snap.skipped.length).toBeGreaterThan(0);
    expect(snap.note).toMatch(/no model was called and nothing here is invented/);
  });

  it("carries the scorecard for all 40 cases", () => {
    expect(snap.scorecard.cases).toHaveLength(40);
  });
});
