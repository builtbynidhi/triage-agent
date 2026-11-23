import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { spanToJson, type SpanJson } from "./span-json.ts";

/**
 * Keeps each trace's finished spans in memory until the worker takes them, so a run's span tree
 * can be saved with the run (and drawn by the web app) without reading the JSONL files back.
 * Bounded: if nobody takes a trace, the oldest are dropped, so a long-running worker cannot leak.
 */
export interface SpanCollector extends SpanProcessor {
  /** The spans of one trace, in start order, removed from memory. */
  take(traceId: string): SpanJson[];
}

const MAX_TRACES = 200;

export function createSpanCollector(): SpanCollector {
  const traces = new Map<string, SpanJson[]>();
  return {
    onStart() {},
    onEnd(span: ReadableSpan) {
      const json = spanToJson(span);
      const list = traces.get(json.trace_id) ?? [];
      list.push(json);
      traces.set(json.trace_id, list);
      if (traces.size > MAX_TRACES) traces.delete(traces.keys().next().value!);
    },
    take(traceId) {
      const list = traces.get(traceId) ?? [];
      traces.delete(traceId);
      return list.sort((a, b) => a.start_ms - b.start_ms);
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
}
