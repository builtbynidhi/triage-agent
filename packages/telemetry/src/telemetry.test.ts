import { context, trace } from "@opentelemetry/api";
import { SimpleSpanProcessor, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSpanCollector } from "./collector.ts";
import { createJsonlSpanExporter } from "./jsonl-exporter.ts";

/** A private provider per test: nothing here touches the process-wide tracer. */
function tracerWith(...processors: ConstructorParameters<typeof SimpleSpanProcessor>[0][]) {
  const provider = new BasicTracerProvider({
    spanProcessors: processors.map((e) => new SimpleSpanProcessor(e)),
  });
  return provider.getTracer("test");
}

describe("the span collector", () => {
  it("hands back one trace's spans in start order, and forgets them", async () => {
    const collector = createSpanCollector();
    const tracer = new BasicTracerProvider({ spanProcessors: [collector] }).getTracer("t");
    const a = tracer.startSpan("first");
    await new Promise((r) => setTimeout(r, 5)); // real runs never start two spans in the same instant
    const b = tracer.startSpan("second", {}, trace.setSpan(context.active(), a)); // a child: same trace
    b.end();
    a.end();
    const traceId = a.spanContext().traceId;
    const spans = collector.take(traceId);
    expect(spans.map((s) => s.name)).toEqual(["first", "second"]); // by start, not by end
    expect(collector.take(traceId)).toEqual([]);
  });

  it("is bounded: a trace nobody takes cannot grow memory forever", () => {
    const collector = createSpanCollector();
    const tracer = new BasicTracerProvider({ spanProcessors: [collector] }).getTracer("t");
    const first = tracer.startSpan("oldest");
    first.end();
    for (let i = 0; i < 250; i++) tracer.startSpan(`s${i}`).end();
    expect(collector.take(first.spanContext().traceId)).toEqual([]); // dropped
  });
});

describe("the JSONL exporter", () => {
  it("appends one JSON object per span, with the OpenTelemetry fields and our timings", () => {
    const dir = mkdtempSync(join(tmpdir(), "spans-"));
    const tracer = tracerWith(createJsonlSpanExporter(dir, () => new Date("2026-11-23T10:00:00Z")));
    const span = tracer.startSpan("execute_tool get_order", {
      attributes: { "gen_ai.tool.name": "get_order" },
    });
    span.addEvent("validation", { ok: true });
    span.end();
    const line = JSON.parse(
      readFileSync(join(dir, "spans-2026-11-23.jsonl"), "utf8").trim(),
    ) as Record<string, unknown>;
    expect(line).toMatchObject({
      name: "execute_tool get_order",
      kind: "INTERNAL",
      parent_span_id: null,
      attributes: { "gen_ai.tool.name": "get_order" },
      status: { code: "UNSET" },
      events: [{ name: "validation", attributes: { ok: true } }],
    });
    expect(typeof line.start_ms).toBe("number");
    expect(line.duration_ms).toBeGreaterThanOrEqual(0);
    expect(line.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });
});
