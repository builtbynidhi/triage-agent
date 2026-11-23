import { fmtMs, fmtTokens } from "@/lib/format";
import { buildSpanTree, type SpanNode } from "@/lib/spans";
import type { SpanView } from "@/lib/types";

/**
 * The run as an OpenTelemetry span tree: invoke_agent wrapping chat spans (model calls) and
 * execute_tool spans (tool calls). Bars sit on a virtual timeline of recorded latencies (see
 * lib/spans.ts), so a replayed run still shows where the time really went.
 */
const KIND_COLOR = (s: SpanView) =>
  s.attributes["gen_ai.operation.name"] === "chat"
    ? "var(--bar)"
    : s.attributes["gen_ai.operation.name"] === "execute_tool"
      ? "var(--bar-tool)"
      : "var(--bar-root)";

function detail(s: SpanView): string {
  const a = s.attributes;
  switch (a["gen_ai.operation.name"]) {
    case "chat":
      return [
        String(a["gen_ai.provider.name"] ?? ""),
        `${fmtTokens(Number(a["gen_ai.usage.input_tokens"] ?? 0))} in → ${fmtTokens(Number(a["gen_ai.usage.output_tokens"] ?? 0))} out`,
        String(a["triage.stage"] ?? ""),
      ]
        .filter(Boolean)
        .join(" · ");
    case "execute_tool":
      return a["triage.tool.ok"] === false
        ? `returned an error: ${String(a["error.type"] ?? "")}`
        : "ok";
    default:
      return [
        `decision ${String(a["triage.decision"] ?? "?")}`,
        `exit ${String(a["triage.exit"] ?? "?")}`,
      ].join(" · ");
  }
}

function Row({ n, total }: { n: SpanNode; total: number }) {
  const left = total ? (100 * n.offsetMs) / total : 0;
  const width = total ? Math.max(0.8, (100 * n.durationMs) / total) : 0;
  const failed = n.span.status.code === "ERROR";
  return (
    <li className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,19rem)_1fr] sm:items-center sm:gap-3">
      <div style={{ paddingLeft: n.depth * 14 }} className="min-w-0">
        <div className="truncate font-mono text-sm" title={n.span.name}>
          {n.span.name}
        </div>
        <div className={`truncate text-xs ${failed ? "text-[var(--bad-fg)]" : "text-muted"}`}>
          {failed ? "✗ " : ""}
          {fmtMs(n.durationMs)} · {detail(n.span)}
        </div>
      </div>
      <div className="relative h-4 rounded bg-line/50" aria-hidden="true">
        <div
          className="absolute top-0 h-4 rounded"
          style={{
            left: `${left}%`,
            width: `${Math.min(width, 100 - left)}%`,
            background: KIND_COLOR(n.span),
          }}
        />
      </div>
    </li>
  );
}

export function SpanTree({ spans }: { spans: SpanView[] }) {
  const { flat, totalMs } = buildSpanTree(spans);
  if (!flat.length) {
    return <p className="text-sm text-muted">No trace was recorded for this run.</p>;
  }
  return (
    <div>
      <ol className="space-y-2.5">
        {flat.map((n) => (
          <Row key={n.span.span_id} n={n} total={totalMs} />
        ))}
      </ol>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <Key color="var(--bar-root)" label="agent run" />
        <Key color="var(--bar)" label="model call (chat)" />
        <Key color="var(--bar-tool)" label="tool call (execute_tool)" />
        <span>
          Durations are the recorded provider latencies; calls are laid out in the order they
          happened.
        </span>
      </p>
    </div>
  );
}

const Key = ({ color, label }: { color: string; label: string }) => (
  <span className="inline-flex items-center gap-1.5">
    <span
      className="inline-block h-2.5 w-2.5 rounded-sm"
      style={{ background: color }}
      aria-hidden="true"
    />
    {label}
  </span>
);
