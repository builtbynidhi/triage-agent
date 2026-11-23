import type { SpanView } from "./types";

/**
 * Turn a flat list of spans into the tree the trace viewer draws, on a VIRTUAL timeline.
 *
 * Why virtual: a run replayed from a recording finishes in milliseconds, but its model calls
 * took seconds when they were recorded. Each `chat` span carries that recorded latency
 * (triage.latency_ms); tool spans keep their own duration. Children are laid out one after the
 * other in the order they happened, so the bars show where the time really went.
 */
export interface SpanNode {
  span: SpanView;
  depth: number;
  /** Where the bar starts and how long it is, in virtual milliseconds. */
  offsetMs: number;
  durationMs: number;
  children: SpanNode[];
}

export const effectiveMs = (s: SpanView): number => {
  const recorded = s.attributes["triage.latency_ms"];
  return typeof recorded === "number" ? recorded : s.duration_ms;
};

export function buildSpanTree(spans: SpanView[]): {
  root: SpanNode | null;
  totalMs: number;
  flat: SpanNode[];
} {
  const byParent = new Map<string | null, SpanView[]>();
  for (const s of spans) {
    byParent.set(s.parent_span_id, [...(byParent.get(s.parent_span_id) ?? []), s]);
  }
  const rootSpan = (byParent.get(null) ?? [])[0];
  if (!rootSpan) return { root: null, totalMs: 0, flat: [] };

  const place = (span: SpanView, depth: number, offsetMs: number): SpanNode => {
    const node: SpanNode = { span, depth, offsetMs, durationMs: effectiveMs(span), children: [] };
    let cursor = offsetMs;
    for (const child of byParent.get(span.span_id) ?? []) {
      const c = place(child, depth + 1, cursor);
      node.children.push(c);
      cursor += c.durationMs;
    }
    // A parent is at least as long as the work laid out inside it.
    node.durationMs = Math.max(node.durationMs, cursor - offsetMs);
    return node;
  };
  const root = place(rootSpan, 0, 0);
  const flat: SpanNode[] = [];
  const walk = (n: SpanNode) => {
    flat.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  return { root, totalMs: root.durationMs, flat };
}
