import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/**
 * One finished span as plain JSON: the shape of a line in traces/*.jsonl, of a run's saved trace,
 * and of what the web app draws. Field names are ours (snake_case); attribute keys are the
 * OpenTelemetry GenAI names (gen_ai.*), pinned to semantic-conventions-genai v0.1.0 (DESIGN.md 2.8).
 */
export interface SpanJson {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: "INTERNAL" | "SERVER" | "CLIENT" | "PRODUCER" | "CONSUMER";
  /** Epoch milliseconds, fractional. */
  start_ms: number;
  duration_ms: number;
  status: { code: "UNSET" | "OK" | "ERROR"; message?: string };
  attributes: Record<string, unknown>;
  events: { name: string; time_ms: number; attributes: Record<string, unknown> }[];
}

const KINDS = ["INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"] as const;
const STATUS = ["UNSET", "OK", "ERROR"] as const;
const ms = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;

export function spanToJson(span: ReadableSpan): SpanJson {
  const ctx = span.spanContext();
  return {
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    parent_span_id: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    kind: KINDS[span.kind] ?? "INTERNAL",
    start_ms: ms(span.startTime),
    duration_ms: ms(span.duration),
    status: {
      code: STATUS[span.status.code] ?? "UNSET",
      ...(span.status.message ? { message: span.status.message } : {}),
    },
    attributes: { ...span.attributes },
    events: span.events.map((e) => ({
      name: e.name,
      time_ms: ms(e.time),
      attributes: { ...e.attributes },
    })),
  };
}
