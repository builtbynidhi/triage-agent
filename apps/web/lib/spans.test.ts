import { describe, expect, it } from "vitest";
import { buildSpanTree, effectiveMs } from "./spans";
import type { SpanView } from "./types";

const span = (
  id: string,
  parent: string | null,
  name: string,
  attrs: Record<string, unknown> = {},
  ms = 1,
): SpanView => ({
  trace_id: "t",
  span_id: id,
  parent_span_id: parent,
  name,
  kind: "INTERNAL",
  start_ms: 0,
  duration_ms: ms,
  status: { code: "UNSET" },
  attributes: attrs,
  events: [],
});

describe("the span tree on a virtual timeline", () => {
  const spans = [
    span("root", null, "invoke_agent triage-agent", {}, 3),
    span("c1", "root", "chat m", { "triage.latency_ms": 26_000 }, 0.4), // replayed: instant now, 26 s when recorded
    span("t1", "root", "execute_tool get_order", {}, 4),
    span("c2", "root", "chat m", { "triage.latency_ms": 24_000 }, 0.3),
  ];

  it("uses a model call's recorded latency, not the instant it took to replay", () => {
    expect(effectiveMs(spans[1]!)).toBe(26_000);
    expect(effectiveMs(spans[2]!)).toBe(4);
  });

  it("lays children out one after another in the order they happened", () => {
    const { flat, totalMs } = buildSpanTree(spans);
    expect(flat.map((n) => [n.span.span_id, n.depth, n.offsetMs])).toEqual([
      ["root", 0, 0],
      ["c1", 1, 0],
      ["t1", 1, 26_000],
      ["c2", 1, 26_004],
    ]);
    expect(totalMs).toBe(50_004); // the parent is as long as the work inside it
  });

  it("copes with no spans and with a trace that has no root", () => {
    expect(buildSpanTree([])).toEqual({ root: null, totalMs: 0, flat: [] });
    expect(buildSpanTree([span("x", "missing-parent", "orphan")]).root).toBeNull();
  });
});
