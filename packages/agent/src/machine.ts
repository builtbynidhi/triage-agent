import {
  CassetteMissError,
  type ChatRequest,
  type ChatResponse,
  type Message,
  type Router,
} from "@triage/providers";
import { Budget, type BudgetExhausted, type BudgetLimits } from "./budget.ts";
import { DECISION_JSON_SCHEMA, type Decision } from "./decision.ts";
import { loadSystemPrompt, type PromptStage, type SystemPrompt } from "./prompts/index.ts";
import { ticketMessage, type Ticket } from "./ticket.ts";
import type { McpTools } from "./tools.ts";
import {
  applyConfidence,
  CONFIDENCE_THRESHOLD,
  parseDecision,
  validateDecision,
  type Validation,
} from "./validate.ts";

/**
 * The bounded agent: a state machine, not a loop that keeps calling the model until something
 * looks right.
 *
 *   CLASSIFY ─► RETRIEVE / GATHER (≤ 2 model turns, ≤ 6 tool calls) ─► DECIDE ─► VALIDATE
 *        └─────────────── budget hit / provider down ───────────────┐     │ fail: one REPAIR
 *                                                                   ▼     ▼ fail again
 *   PROPOSE (await human approval) ─► CLOSED            ESCALATE with the facts gathered so far
 *
 * The model reads the ticket and decides which tools to call (through MCP only); it never acts.
 * Every outcome that is not a validated decision is a safe ESCALATE: a human gets a partly
 * researched ticket rather than a guess.
 */
export type State =
  | "start"
  | "classify"
  | "retrieve"
  | "gather"
  | "decide"
  | "validate"
  | "repair"
  | "propose"
  | "escalate"
  | "closed";

export interface StepRecord {
  seq: number;
  state: State;
  kind: "transition" | "model_call" | "tool_call" | "validation";
  name: string;
  /** Inputs worth auditing. Never the full prompt (content capture is opt-in, off by default). */
  input?: unknown;
  output?: unknown;
  /** Real work time. For model calls: provider latency, excluding free-tier pacing (waitMs). */
  ms: number;
  /** For model calls: time spent waiting on our own pacing before calling. */
  waitMs?: number;
  /** For model calls. */
  provider?: string;
  model?: string;
  source?: string;
  tokens?: { input: number; output: number; thinking: number };
  listPriceUsd?: number;
  /** Budget after this step. */
  budget: { steps: number; toolCalls: number; tokens: number };
}

export type Proposal =
  | { action: "send_reply"; payload: { body: string; clause_ids: string[] } }
  | { action: "create_escalation"; payload: { reason: string; summary: string; facts: string[] } };

export type Exit = "decided" | "budget" | "validation_failed" | "provider_error";

export interface RunResult {
  decision: Decision;
  /** The write the agent proposes; a human must approve it. Null for REJECT. */
  proposal: Proposal | null;
  status: "awaiting_approval" | "done";
  exit: Exit;
  /** Present when exit is not "decided": why the run ended early. */
  exitReason?: string;
  downgraded: boolean;
  repaired: boolean;
  steps: StepRecord[];
  usage: { steps: number; toolCalls: number; tokens: number; modelCalls: number };
  listPriceUsd: number;
  prompt: { version: string; hash: string };
  /** Clause IDs that tools returned this run: the only ones a decision may cite. */
  citableClauseIds: string[];
}

export interface AgentOptions {
  ticket: Ticket;
  tools: McpTools;
  router: Pick<Router, "complete">;
  /** YYYY-MM-DD, shown to the model; tools use the server's own clock. */
  today: string;
  budget?: Partial<BudgetLimits>;
  confidenceThreshold?: number;
  /** Model turns allowed for tool gathering (the first one is the classify turn). */
  maxGatherRounds?: number;
  prompt?: SystemPrompt;
  onStep?: (step: StepRecord) => void;
}

class StopRun extends Error {
  readonly exit: Exit;
  constructor(exit: Exit, reason: string) {
    super(reason);
    this.exit = exit;
  }
}

const BUDGET_REASON: Record<BudgetExhausted, string> = {
  steps: "step budget",
  tool_calls: "tool-call budget",
  tokens: "token budget",
};

export async function runAgent(opts: AgentOptions): Promise<RunResult> {
  const prompt = opts.prompt ?? loadSystemPrompt();
  const budget = new Budget(opts.budget);
  const maxRounds = opts.maxGatherRounds ?? 2;
  const steps: StepRecord[] = [];
  const citable = new Set<string>();
  const facts: string[] = [];
  let listPrice = 0;
  let modelCalls = 0;
  let repaired = false;

  const record = (s: Omit<StepRecord, "seq" | "budget">) => {
    const step: StepRecord = {
      ...s,
      seq: steps.length + 1,
      budget: { steps: budget.steps, toolCalls: budget.toolCalls, tokens: budget.tokens },
    };
    steps.push(step);
    opts.onStep?.(step);
  };
  const transition = (state: State, name: string) =>
    record({ state, kind: "transition", name, ms: 0 });

  async function model(
    state: State,
    stage: PromptStage,
    req: Omit<ChatRequest, "system">,
  ): Promise<ChatResponse> {
    const blocked = budget.blocksModelCall();
    if (blocked)
      throw new StopRun(
        "budget",
        `${BUDGET_REASON[blocked]} exhausted before the ${state} model call`,
      );
    let res: ChatResponse;
    try {
      res = await opts.router.complete({ system: prompt.forStage(stage), ...req });
    } catch (err) {
      if (err instanceof CassetteMissError) throw err; // a harness problem: fail loudly, never fake a decision
      throw new StopRun(
        "provider_error",
        `model unavailable during ${state}: ${(err as Error).message}`,
      );
    }
    modelCalls++;
    const u = res.usage;
    budget.spendModelCall(u.inputTokens + u.outputTokens + u.thinkingTokens);
    listPrice += res.listPriceUsd;
    record({
      state,
      kind: "model_call",
      name: stage,
      ms: res.latencyMs,
      waitMs: res.waitMs,
      provider: res.provider,
      model: res.model,
      source: res.source,
      tokens: { input: u.inputTokens, output: u.outputTokens, thinking: u.thinkingTokens },
      listPriceUsd: res.listPriceUsd,
      output: { finishReason: res.finishReason, toolCalls: res.toolCalls.map((c) => c.name) },
    });
    if (budget.overTokens())
      throw new StopRun(
        "budget",
        `${BUDGET_REASON.tokens} exhausted after the ${state} model call`,
      );
    return res;
  }

  const messages: Message[] = [
    {
      role: "user",
      content: ticketMessage(opts.ticket, { merchant: opts.tools.merchant, today: opts.today }),
    },
  ];
  const assistantTurn = (r: ChatResponse): Message => ({
    role: "assistant",
    content: r.text,
    toolCalls: r.toolCalls,
    providerState: r.providerState,
  });

  const validateText = (text: string): Validation => {
    const parsed = parseDecision(text);
    return parsed.ok ? validateDecision(parsed.decision, { citableClauseIds: citable }) : parsed;
  };

  try {
    transition("classify", "start → classify");

    // CLASSIFY, then RETRIEVE / GATHER: the model chooses tools; the machine executes them.
    for (let round = 0; round < maxRounds; round++) {
      const turn = await model(round === 0 ? "classify" : "gather", "gather", {
        messages,
        tools: opts.tools.specs,
        maxOutputTokens: 512,
      });
      if (!turn.toolCalls.length) break;
      messages.push(assistantTurn(turn));
      for (const call of turn.toolCalls) {
        const blocked = budget.blocksToolCall();
        if (blocked)
          throw new StopRun("budget", `${BUDGET_REASON[blocked]} exhausted before ${call.name}`);
        const state: State = call.name === "search_policy" ? "retrieve" : "gather";
        const t0 = performance.now();
        const result = await opts.tools.call(call.name, call.arguments);
        budget.spendToolCall();
        harvest(call.name, result.structured);
        record({
          state,
          kind: "tool_call",
          name: call.name,
          input: call.arguments,
          output: result.structured,
          ms: Math.round(performance.now() - t0),
        });
        // Tool results go back as tool messages, never into the system prompt.
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.text });
      }
    }

    // DECIDE: schema-shaped answer, no tools.
    transition("decide", "gather → decide");
    const decideReq = {
      responseSchema: { name: "decision", schema: DECISION_JSON_SCHEMA },
      maxOutputTokens: 1024,
    };
    const first = await model("decide", "decide", { messages, ...decideReq });
    let verdict = validateText(first.text);
    record({
      state: "validate",
      kind: "validation",
      name: "validate",
      ms: 0,
      output: verdict.ok ? { ok: true } : { ok: false, errors: verdict.errors },
    });

    // REPAIR: exactly one attempt, shown the rule violations.
    if (!verdict.ok) {
      repaired = true;
      messages.push(assistantTurn(first));
      messages.push({
        role: "user",
        content: `Your decision object broke these rules:\n${verdict.errors.map((e) => `- ${e}`).join("\n")}\nReturn a corrected decision object.`,
      });
      const second = await model("repair", "repair", { messages, ...decideReq });
      verdict = validateText(second.text);
      record({
        state: "validate",
        kind: "validation",
        name: "validate after repair",
        ms: 0,
        output: verdict.ok ? { ok: true } : { ok: false, errors: verdict.errors },
      });
      if (!verdict.ok)
        throw new StopRun(
          "validation_failed",
          `decision still invalid after one repair: ${verdict.errors.join("; ")}`,
        );
    }

    const { decision, downgraded } = applyConfidence(
      verdict.decision,
      opts.confidenceThreshold ?? CONFIDENCE_THRESHOLD,
    );
    return finish(decision, "decided", undefined, downgraded);
  } catch (err) {
    if (!(err instanceof StopRun)) throw err;
    // Fail closed: a human gets the ticket with whatever was gathered.
    transition("escalate", `${err.exit} → escalate`);
    return finish(failClosed(err.message), err.exit, err.message, false);
  }

  function harvest(tool: string, s: Record<string, unknown>) {
    if (tool === "search_policy" && Array.isArray(s.results)) {
      for (const r of s.results as { clause_id?: string }[])
        if (r.clause_id) citable.add(r.clause_id);
    }
    if (tool === "check_eligibility" && Array.isArray(s.clause_ids)) {
      for (const id of s.clause_ids as string[]) citable.add(id);
    }
    facts.push(
      s.ok === false
        ? `${tool}: ${String(s.code)}`
        : tool === "get_order"
          ? `order ${(s.order as { order_id?: string })?.order_id ?? ""}: ${(s.order as { status?: string })?.status ?? ""}`
          : `${tool}: ok`,
    );
  }

  function failClosed(reason: string): Decision {
    return {
      decision: "ESCALATE",
      intent: "other",
      confidence: 0,
      facts_used: [...facts],
      clause_ids: [],
      reply_draft: "",
      escalation_reason: `Automatic escalation: ${reason}.`,
      missing_fields: [],
    };
  }

  function finish(
    decision: Decision,
    exit: Exit,
    exitReason: string | undefined,
    downgraded: boolean,
  ): RunResult {
    const proposal: Proposal | null =
      decision.decision === "REJECT"
        ? null
        : decision.decision === "ESCALATE"
          ? {
              action: "create_escalation",
              payload: {
                reason: decision.escalation_reason,
                summary: decision.reply_draft || facts.join("; ") || "No facts gathered.",
                facts: [...facts],
              },
            }
          : {
              action: "send_reply",
              payload: { body: decision.reply_draft, clause_ids: decision.clause_ids },
            };
    transition(
      "propose",
      proposal ? `propose ${proposal.action} (awaiting approval)` : "no proposal (REJECT)",
    );
    transition("closed", "closed");
    return {
      decision,
      proposal,
      status: proposal ? "awaiting_approval" : "done",
      exit,
      exitReason,
      downgraded,
      repaired,
      steps,
      usage: {
        steps: budget.steps,
        toolCalls: budget.toolCalls,
        tokens: budget.tokens,
        modelCalls,
      },
      listPriceUsd: Math.round(listPrice * 1e10) / 1e10,
      prompt: { version: prompt.version, hash: prompt.hash },
      citableClauseIds: [...citable].sort(),
    };
  }
}
