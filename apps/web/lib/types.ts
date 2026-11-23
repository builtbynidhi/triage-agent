/**
 * The shapes the web app reads. They mirror what the Express API returns (apps/api/src/app.ts) and
 * what `pnpm web:snapshot` writes, so the same pages work in both modes.
 */
export type DecisionKind = "AUTO_REPLY" | "NEEDS_INFO" | "ESCALATE" | "REJECT";
export type RunStatus = "queued" | "running" | "awaiting_approval" | "done" | "failed";

export interface RunSummary {
  id: string;
  status: RunStatus;
  decision: DecisionKind | null;
  ticket: { channel: string; text: string; order_id: string | null };
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  latency_ms: number;
  failure: unknown;
  created_at: string;
  finished_at: string | null;
  /** Snapshot only: which eval case this run came from. */
  case_id?: string;
  category?: string;
}

export interface StepView {
  seq: number;
  kind: "transition" | "model_call" | "tool_call" | "validation";
  name: string;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  createdAt: string;
}

/** One OpenTelemetry span as JSON (packages/telemetry, GenAI conventions v0.1.0). */
export interface SpanView {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_ms: number;
  duration_ms: number;
  status: { code: "UNSET" | "OK" | "ERROR"; message?: string };
  attributes: Record<string, unknown>;
  events: { name: string; time_ms: number; attributes: Record<string, unknown> }[];
}

export interface ApprovalView {
  id: string;
  run_id: string;
  action: "create_escalation" | "send_reply";
  status: "pending" | "approved" | "rejected";
  payload: Record<string, unknown>;
  reviewer: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface DecisionObject {
  decision: DecisionKind;
  intent: string;
  confidence: number;
  facts_used: string[];
  clause_ids: string[];
  reply_draft: string;
  escalation_reason: string;
  missing_fields: string[];
  exit?: string;
  exit_reason?: string | null;
  downgraded?: boolean;
  repaired?: boolean;
  prompt?: { version: string; hash: string };
  failure?: Record<string, unknown>;
}

export interface RunDetail extends RunSummary {
  result: DecisionObject | null;
  steps: StepView[];
  trace: SpanView[];
  approvals: ApprovalView[];
}

export interface ScorecardData {
  meta: Record<string, unknown>;
  card: Record<string, unknown>;
  cases: {
    case_id: string;
    category: string;
    passed: number;
    scored: number;
    reasons: string[];
    incomplete: string | null;
  }[];
}

export interface Snapshot {
  generated_at: string;
  note: string;
  today: string;
  skipped: { case_id: string; why: string }[];
  runs: RunDetail[];
  scorecard: ScorecardData;
}
