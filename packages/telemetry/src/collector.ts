import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { spanToJson, type SpanJson } from "./span-json.ts";

/**
 * Keeps each trace's finished spans in memory until the worker takes them, so a run's span tree
 * can be saved with the run (and drawn by the web app) without reading the JSONL files back.
 * Bounded: if nobody takes a trace, the oldest are dropped, so a long-running worker cannot leak.
 */
export interface SpanCollector extends SpanProcessor {
  /**
   * The spans of one trace, in start order, removed from memory. The runtime's span clock ticks in
   * whole milliseconds, so spans that start in the same millisecond are put in the order they
   * were created, which is the order things happened.
   */
  take(traceId: string): SpanJson[];
}

const MAX_TRACES = 200;

export function createSpanCollector(): SpanCollector {
  const traces = new Map<string, SpanJson[]>();
  const created = new Map<string, number>(); // span ID -> creation order
  let counter = 0;
  return {
    onStart(span: Span) {
      created.set(span.spanContext().spanId, counter++);
    },
    onEnd(span: ReadableSpan) {
      const json = spanToJson(span);
      const list = traces.get(json.trace_id) ?? [];
      list.push(json);
      traces.set(json.trace_id, list);
      if (traces.size > MAX_TRACES) {
        for (const dropped of traces.get(traces.keys().next().value!) ?? [])
          created.delete(dropped.span_id);
        traces.delete(traces.keys().next().value!);
      }
    },
    take(traceId) {
      const list = traces.get(traceId) ?? [];
      traces.delete(traceId);
      const order = (j: SpanJson) => created.get(j.span_id) ?? 0;
      const sorted = list.sort((a, b) => a.start_ms - b.start_ms || order(a) - order(b));
      for (const j of list) created.delete(j.span_id);
      return sorted;
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
}
