import { fmtMs } from "@/lib/format";
import type { StepView } from "@/lib/types";
import { JsonBlock } from "./json-block";

const compact = (v: unknown) => JSON.stringify(v ?? {});

const failed = (output: unknown) =>
  typeof output === "object" && output !== null && (output as { ok?: unknown }).ok === false;

/** Every tool the agent called: the arguments it sent and exactly what came back. */
export function ToolCalls({ steps }: { steps: StepView[] }) {
  const calls = steps.filter((s) => s.kind === "tool_call");
  if (!calls.length) return <p className="text-sm text-muted">The agent called no tools.</p>;
  return (
    <ul className="space-y-2">
      {calls.map((s) => {
        const bad = failed(s.output);
        const code = bad ? String((s.output as { code?: unknown }).code ?? "error") : null;
        return (
          <li key={s.seq} className="rounded border border-line bg-surface">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
              <span className="font-mono text-sm font-semibold">{s.name}</span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs text-muted"
                title={compact(s.input)}
              >
                {compact(s.input)}
              </span>
              <span className={`text-xs ${bad ? "text-[var(--bad-fg)]" : "text-muted"}`}>
                {bad ? `✗ ${code}` : "✓ ok"} · {fmtMs(s.durationMs ?? 0)}
              </span>
            </div>
            <div className="grid gap-2 border-t border-line p-2 md:grid-cols-2">
              <JsonBlock label="Arguments" value={s.input ?? {}} />
              <JsonBlock label="Result" value={s.output ?? {}} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
