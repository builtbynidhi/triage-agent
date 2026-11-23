import Link from "next/link";
import { DecisionBadge, StatusBadge } from "@/components/badge";
import { getMode, getSnapshotInfo, listRuns } from "@/lib/data";
import { excerpt, fmtMs, fmtTokens, fmtUsd, median } from "@/lib/format";
import type { DecisionKind } from "@/lib/types";

export const metadata = { title: "Runs" };

const DECISIONS: DecisionKind[] = ["AUTO_REPLY", "NEEDS_INFO", "ESCALATE", "REJECT"];

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ decision?: string }>;
}) {
  const { decision } = await searchParams;
  const runs = await listRuns();
  const shown = DECISIONS.includes(decision as DecisionKind)
    ? runs.filter((r) => r.decision === decision)
    : runs;
  const counts = Object.fromEntries(
    DECISIONS.map((d) => [d, runs.filter((r) => r.decision === d).length]),
  );
  const info = getSnapshotInfo();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Runs</h1>
        {getMode() === "snapshot" ? (
          <p className="mt-1 max-w-3xl text-sm text-muted">
            {info.runCount} real runs of the agent, shown read-only. Each ticket went through the
            real worker (agent, hybrid policy retrieval, tools, OpenTelemetry spans) with the model
            replayed from its recording, so nothing here is invented. Open a run to see its span
            tree, tool calls, retrieved policy and decision.
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted">Live runs from the API, newest first.</p>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Runs" value={String(runs.length)} />
        <Stat label="Median latency" value={fmtMs(median(runs.map((r) => r.latency_ms)) ?? NaN)} />
        <Stat
          label="List-price cost, all runs"
          value={fmtUsd(runs.reduce((n, r) => n + r.usage.cost_usd, 0))}
          hint="Actual cost: $0, free tiers"
        />
        <Stat
          label="Tokens, all runs"
          value={fmtTokens(
            runs.reduce((n, r) => n + r.usage.input_tokens + r.usage.output_tokens, 0),
          )}
        />
      </dl>

      <nav aria-label="Filter by decision" className="flex flex-wrap gap-2 text-sm">
        <Chip href="/" active={!decision} label={`All (${runs.length})`} />
        {DECISIONS.map((d) => (
          <Chip
            key={d}
            href={`/?decision=${d}`}
            active={decision === d}
            label={`${d} (${counts[d] ?? 0})`}
          />
        ))}
      </nav>

      <div className="overflow-x-auto rounded border border-line bg-surface">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <caption className="sr-only">Runs, newest first</caption>
          <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Ticket
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Decision
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Latency
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Tokens
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Cost (list)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((r) => (
              <tr key={r.id} className="hover:bg-line/30">
                <td className="max-w-md px-3 py-2">
                  <Link href={`/runs/${r.id}`} className="font-medium">
                    {excerpt(r.ticket.text, 80)}
                  </Link>
                  <div className="text-xs text-muted">
                    {r.case_id ? `${r.case_id} · ` : ""}
                    {r.ticket.channel}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <DecisionBadge decision={r.decision} />
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMs(r.latency_ms)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtTokens(r.usage.input_tokens + r.usage.output_tokens)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(r.usage.cost_usd)}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted">
                  No runs match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {getMode() === "snapshot" && info.skipped.length > 0 && (
        <p className="text-xs text-muted">
          Not shown ({info.skipped.length}):{" "}
          {info.skipped.map((s) => `${s.case_id} (${s.why})`).join("; ")}.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-line bg-surface px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

function Chip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`rounded-full border px-3 py-1 no-underline ${active ? "border-accent bg-accent/10 font-semibold text-fg" : "border-line text-muted hover:text-fg"}`}
    >
      {label}
    </Link>
  );
}
