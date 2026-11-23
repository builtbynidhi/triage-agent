import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createSpanCollector, type SpanCollector } from "./collector.ts";
import { createJsonlSpanExporter } from "./jsonl-exporter.ts";

export interface TelemetryOptions {
  /** Where the JSONL files go. Unset: no file exporter. */
  traceDir?: string;
  /** An OTLP/HTTP traces URL (for Langfuse: https://cloud.langfuse.com/api/public/otel/v1/traces). Unset: no OTLP. */
  otlpEndpoint?: string;
  serviceName?: string;
}

export interface Telemetry {
  collector: SpanCollector;
  /** Which exporters are on, for the startup log. */
  exporters: string[];
  shutdown(): Promise<void>;
}

let started: Telemetry | undefined;

/**
 * Turn tracing on for this process. Exporters, both free: a JSONL file under traces/ by default,
 * and OTLP when an endpoint is configured (headers come from the standard OTEL_EXPORTER_OTLP_HEADERS
 * variable, so a key never sits in code). Message content is NOT captured here: the agent only
 * records prompts and tool arguments on its spans when CAPTURE_MESSAGE_CONTENT is true.
 * Safe to call twice; the first call wins.
 */
export function initTelemetry(opts: TelemetryOptions = {}): Telemetry {
  if (started) return started;
  process.env.OTEL_SERVICE_NAME ??= opts.serviceName ?? "triage-agent";
  const collector = createSpanCollector();
  const processors: SpanProcessor[] = [collector];
  const exporters: string[] = ["run-trace store"];
  if (opts.traceDir) {
    processors.push(new SimpleSpanProcessor(createJsonlSpanExporter(opts.traceDir)));
    exporters.push(`JSONL (${opts.traceDir})`);
  }
  if (opts.otlpEndpoint) {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: opts.otlpEndpoint })));
    exporters.push("OTLP");
  }
  const provider = new BasicTracerProvider({ spanProcessors: processors });
  trace.setGlobalTracerProvider(provider);
  started = { collector, exporters, shutdown: () => provider.shutdown() };
  return started;
}
