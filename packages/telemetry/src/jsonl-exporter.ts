import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { spanToJson } from "./span-json.ts";

/**
 * The default exporter, and all the local trace viewer needs: one JSON object per finished span,
 * appended to traces/spans-YYYY-MM-DD.jsonl. It is free, offline and greppable; the OTLP exporter
 * is optional and sends the same spans to Langfuse or any OTLP backend.
 */
export function createJsonlSpanExporter(
  dir: string,
  now: () => Date = () => new Date(),
): SpanExporter {
  mkdirSync(dir, { recursive: true });
  return {
    export(spans: ReadableSpan[], done: (r: ExportResult) => void) {
      try {
        const file = join(dir, `spans-${now().toISOString().slice(0, 10)}.jsonl`);
        appendFileSync(file, spans.map((s) => JSON.stringify(spanToJson(s))).join("\n") + "\n");
        done({ code: ExportResultCode.SUCCESS });
      } catch (error) {
        done({ code: ExportResultCode.FAILED, error: error as Error });
      }
    },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
}
