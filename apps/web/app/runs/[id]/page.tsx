import Link from "next/link";
import { notFound } from "next/navigation";
import { DecisionBadge, StatusBadge } from "@/components/badge";
import { RetrievedClauses } from "@/components/clauses";
import { JsonBlock } from "@/components/json-block";
import { LivePanel, type ReplayStep } from "@/components/live-panel";
import { SpanTree } from "@/components/span-tree";
import { ToolCalls } from "@/components/tool-calls";
import { getMode, getRun, staticRunIds } from "@/lib/data";
import { excerpt, fmtMs, fmtTokens, fmtUsd } from "@/lib/format";
import type { RunDetail, StepView } from "@/lib/types";

export const generateStaticParams = async () => staticRunIds().map((id) => ({ id }));

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const run = await getRun((await params).id);
  return { title: run ? excerpt(run.ticket.text, 50) : "Run not found" };
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const run = await getRun((await params).id);
  if (!run) notFound();
  const r = run.result;
  const mode = getMode();

  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="text-sm">
          ← All runs
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{excerpt(run.ticket.text, 110)}</h1>
        <p className="mt-1 font-mono text-xs text-muted">
          {run.id}
          {run.case_id ? ` · eval case ${run.case_id}` : ""} · {run.ticket.channel} ·{" "}
          {run.created_at.slice(0, 16).replace("T", " ")} UTC
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Decision">
          <DecisionBadge decision={run.decision} />
        </Fact>
        <Fact label="Status">
          <StatusBadge status={run.status} />
        </Fact>
        <Fact label="Latency (recorded)">{fmtMs(run.latency_ms)}</Fact>
        <Fact label="Tokens in → out">
          {fmtTokens(run.usage.input_tokens)} → {fmtTokens(run.usage.output_tokens)}
        </Fact>
        <Fact label="Cost at list price" hint="Actual: $0, free tiers">
          {fmtUsd(run.usage.cost_usd)}
        </Fact>
        <Fact label="Prompt">{r?.prompt ? `${r.prompt.version} #${r.prompt.hash}` : "n/a"}</Fact>
      </dl>

      <Section title="The ticket">
        <blockquote className="whitespace-pre-wrap rounded border border-line bg-surface p-3 text-sm">
          {run.ticket.text}
        </blockquote>
      </Section>

      {r ? (
        <DecisionCard run={run} />
      ) : (
        <p className="text-sm text-muted">This run has no decision yet.</p>
      )}

      <Section
        title="Span tree"
        note="OpenTelemetry GenAI spans (conventions v0.1.0, status Development): invoke_agent wraps one chat span per model call and one execute_tool span per tool call."
      >
        <SpanTree spans={run.trace} />
      </Section>

      <Section title={mode === "live" ? "Live view" : "Replay"}>
        <LivePanel
          runId={run.id}
          mode={mode}
          running={run.status === "queued" || run.status === "running"}
          steps={replaySteps(run.steps)}
        />
      </Section>

      <Section
        title="Tool calls and results"
        note="Exactly what the agent sent each tool and what came back."
      >
        <ToolCalls steps={run.steps} />
      </Section>

      <Section
        title="Retrieved policy clauses"
        note="What search_policy returned, with the reranker's score. Only a clause the agent actually retrieved can be cited."
      >
        <RetrievedClauses steps={run.steps} cited={r?.clause_ids ?? []} />
      </Section>

      <Section title="Validation">
        <Validation run={run} />
      </Section>

      <Section title="Final decision object">
        {r ? (
          <JsonBlock label="The object the model returned, as validated" value={r} open />
        ) : null}
        {r?.failure && (
          <div className="mt-3">
            <JsonBlock
              label="Failure detail: prompt hash, validation, budget at exit, retrieved clauses"
              value={r.failure}
              open
            />
          </div>
        )}
      </Section>

      {run.approvals.length > 0 && (
        <Section title="Approvals" note="The agent only proposes. A reviewer decides.">
          <ul className="space-y-2">
            {run.approvals.map((a) => (
              <li key={a.id} className="rounded border border-line bg-surface p-3 text-sm">
                <div className="flex flex-wrap items-center gap-x-3">
                  <span className="font-mono font-semibold">{a.action}</span>
                  <span className="rounded border border-line px-1.5 text-xs">{a.status}</span>
                  {a.reviewer && <span className="text-xs text-muted">by {a.reviewer}</span>}
                </div>
                <JsonBlock label="Proposed payload" value={a.payload} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function DecisionCard({ run }: { run: RunDetail }) {
  const r = run.result!;
  return (
    <Section title="Decision and draft reply">
      <div className="space-y-3 rounded border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <DecisionBadge decision={r.decision} />
          <span>
            intent <span className="font-mono">{r.intent}</span>
          </span>
          <span>
            confidence <span className="font-mono">{r.confidence.toFixed(2)}</span>
          </span>
          {r.repaired && <span className="text-[var(--info-fg)]">repaired once</span>}
          {r.downgraded && (
            <span className="text-[var(--esc-fg)]">downgraded for low confidence</span>
          )}
          {r.exit && r.exit !== "decided" && (
            <span className="text-[var(--bad-fg)]">ended early: {r.exit}</span>
          )}
        </div>
        {r.reply_draft ? (
          <blockquote className="whitespace-pre-wrap border-l-4 border-line pl-3 text-sm">
            {r.reply_draft}
          </blockquote>
        ) : (
          <p className="text-sm text-muted">No reply drafted (this decision sends none).</p>
        )}
        {r.escalation_reason && (
          <p className="text-sm">
            <span className="font-semibold">Escalation reason:</span> {r.escalation_reason}
          </p>
        )}
        {r.missing_fields.length > 0 && (
          <p className="text-sm">
            <span className="font-semibold">Asked for:</span> {r.missing_fields.join(", ")}
          </p>
        )}
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">Cites:</span>
          {r.clause_ids.length ? (
            r.clause_ids.map((c) => (
              <code key={c} className="rounded bg-line/60 px-1.5 py-0.5 text-xs">
                {c}
              </code>
            ))
          ) : (
            <span className="text-muted">no clause</span>
          )}
        </p>
      </div>
    </Section>
  );
}

function Validation({ run }: { run: RunDetail }) {
  const checks = run.steps.filter((s) => s.kind === "validation");
  if (!checks.length)
    return (
      <p className="text-sm text-muted">No validation ran (the run ended before a decision).</p>
    );
  return (
    <ul className="space-y-2">
      {checks.map((s) => {
        const o = s.output as { ok: boolean; errors?: string[] };
        return (
          <li key={s.seq} className="rounded border border-line bg-surface p-3 text-sm">
            <span className="font-mono">{s.name}</span>:{" "}
            {o.ok ? (
              <span className="font-semibold text-[var(--ok-fg)]">✓ passed</span>
            ) : (
              <span className="font-semibold text-[var(--bad-fg)]">✗ failed</span>
            )}
            {!o.ok && (
              <ul className="mt-1 list-disc pl-5 text-muted">
                {(o.errors ?? []).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function replaySteps(steps: StepView[]): ReplayStep[] {
  return steps.flatMap((s): ReplayStep[] => {
    if (s.kind === "model_call") {
      const o = (s.output ?? {}) as { model?: string };
      return [
        {
          kind: "model_call",
          label: `chat ${o.model ?? "model"} (${s.name})`,
          ms: s.durationMs ?? 0,
        },
      ];
    }
    if (s.kind === "tool_call")
      return [{ kind: "tool_call", label: `execute_tool ${s.name}`, ms: s.durationMs ?? 0 }];
    if (s.kind === "validation") {
      const ok = (s.output as { ok?: boolean } | undefined)?.ok;
      return [{ kind: "validation", label: `${s.name}: ${ok ? "passed" : "failed"}`, ms: 0 }];
    }
    return [];
  });
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      {note && <p className="mb-3 mt-0.5 max-w-3xl text-sm text-muted">{note}</p>}
      <div className={note ? "" : "mt-2"}>{children}</div>
    </section>
  );
}

function Fact({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border border-line bg-surface px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums">{children}</dd>
      {hint && <div className="text-xs font-normal text-muted">{hint}</div>}
    </div>
  );
}
