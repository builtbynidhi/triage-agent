import type { DecisionKind, RunStatus } from "@/lib/types";

const DECISION: Record<DecisionKind, { cls: string; glyph: string; label: string }> = {
  AUTO_REPLY: { cls: "bg-[var(--ok-bg)] text-[var(--ok-fg)]", glyph: "✓", label: "AUTO_REPLY" },
  NEEDS_INFO: { cls: "bg-[var(--info-bg)] text-[var(--info-fg)]", glyph: "?", label: "NEEDS_INFO" },
  ESCALATE: { cls: "bg-[var(--esc-bg)] text-[var(--esc-fg)]", glyph: "↑", label: "ESCALATE" },
  REJECT: { cls: "bg-[var(--rej-bg)] text-[var(--rej-fg)]", glyph: "✕", label: "REJECT" },
};

const base =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold";

/** The decision, by glyph and name as well as colour, so it reads the same without colour. */
export function DecisionBadge({ decision }: { decision: DecisionKind | null }) {
  if (!decision) return <span className={`${base} bg-line text-muted`}>no decision yet</span>;
  const d = DECISION[decision];
  return (
    <span className={`${base} ${d.cls}`}>
      <span aria-hidden="true">{d.glyph}</span>
      {d.label}
    </span>
  );
}

const STATUS: Record<RunStatus, string> = {
  queued: "queued",
  running: "running",
  awaiting_approval: "awaiting approval",
  done: "done",
  failed: "failed",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const tone =
    status === "failed"
      ? "border-[var(--bad-fg)] text-[var(--bad-fg)]"
      : status === "awaiting_approval"
        ? "border-[var(--info-fg)] text-[var(--info-fg)]"
        : "border-line text-muted";
  return (
    <span className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${tone}`}>
      {STATUS[status]}
    </span>
  );
}
