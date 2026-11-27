import { context, SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import {
  CassetteMissError,
  type ChatRequest,
  type ChatResponse,
  type Message,
  type Router,
} from "@triage/providers";
import { Budget, type BudgetExhausted, type BudgetLimits } from "./budget.ts";
import { DECISION_JSON_SCHEMA, type Decision } from "./decision.ts";
import { injectionMarkers, instructionLike, quarantineTicket } from "./guard.ts";
import { loadSystemPrompt, type PromptStage, type SystemPrompt } from "./prompts/index.ts";
import { SAFETY_CLAUSE, SAFETY_NOTICE, safetyHazard, stripClauseIds } from "./reply-rules.ts";
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
  | "quarantine"
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
  /** For replayed model calls: the provider latency measured when the answer was recorded. */
  recordedMs?: number;
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

/** "quarantined": the ticket carried an unmistakable override attempt and was REJECTed before any model call. */
export type Exit = "decided" | "budget" | "validation_failed" | "provider_error" | "quarantined";

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
  /** Retrieved clauses that gave orders to the assistant: never citable (guard.ts). */
  quarantinedClauseIds: string[];
  /** The OpenTelemetry trace ID of this run's span tree (all zeros when tracing is off). */
  traceId: string;
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
  /**
   * Record message and tool content (prompts, tool arguments and results) on the spans. OFF by
   * default: they hold customer text. The OpenTelemetry GenAI conventions make this opt-in too.
   */
  captureContent?: boolean;
  /** Extra attributes for the run's root span, e.g. { "triage.run_id": "run_..." }. */
  traceAttributes?: Record<string, string | number | boolean>;
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

/**
 * What the model is shown for a tool result. Identical to the structured result, except that
 * search_policy relevance scores are dropped: the ranked order carries the relevance, and scores
 * are floats that differ in the third decimal between CPUs (int8 model maths). Keeping them would
 * change the request, and so the recording key, on every other machine. Measured: a run recorded
 * on macOS arm64 missed every recording on the Linux x86 CI runner until scores were removed.
 * The full result, scores included, stays in the step record.
 */
export function modelView(
  tool: string,
  structured: Record<string, unknown>,
  policyText: { clause_id: string; title: string; text: string }[] = [],
): string {
  if (policyText.length) {
    // The wording of the clauses a tool named by ID only (see policyTextFor in runAgent).
    return JSON.stringify({
      ...structured,
      policy_text: policyText.map(({ clause_id, title, text }) => ({ clause_id, title, text })),
    });
  }
  if (tool === "search_policy" && Array.isArray(structured.results)) {
    const results = (structured.results as Record<string, unknown>[]).map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => k !== "score")),
    );
    return JSON.stringify({ ...structured, results });
  }
  return JSON.stringify(structured);
}

/** The search for an order not yet delivered: its question is when it arrives (delivery policy). */
export const DELIVERY_QUERY = "delivery time, dispatch time and tracking";

/**
 * What the machine searches the policy for when the model found an order but read no policy:
 * null when no order was found (nothing to answer from). For an order still on its way, the
 * delivery question (whole-ticket searches rank cancellation and address clauses first for
 * "where is my order"); otherwise the customer's own words, with quoted earlier emails ("> ...")
 * left out, since a quote is not the customer's request.
 */
export function machineQuery(ticketText: string, orderStatus: string | null): string | null {
  if (!orderStatus) return null;
  if (orderStatus === "placed" || orderStatus === "dispatched") return DELIVERY_QUERY;
  const own = ticketText
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
    .trim();
  return own || null;
}

export async function runAgent(opts: AgentOptions): Promise<RunResult> {
  const prompt = opts.prompt ?? loadSystemPrompt();
  const budget = new Budget(opts.budget);
  const maxRounds = opts.maxGatherRounds ?? 2;
  const steps: StepRecord[] = [];
  const citable = new Set<string>();
  const quarantinedClauses = new Set<string>();
  const humanOnlyActions = new Set<string>();
  const facts: string[] = [];
  /** The status of the last order get_order found this run, if any. */
  let orderStatus: string | null = null;
  // Input quarantine: invisible characters out, length capped. A normal ticket comes back unchanged.
  const quarantined = quarantineTicket(opts.ticket);
  const ticket = quarantined.ticket;
  const promptText = (["gather", "decide", "repair"] as const)
    .map((stage) => prompt.forStage(stage))
    .join("\n");
  let listPrice = 0;
  let modelCalls = 0;
  let repaired = false;
  let inputTotal = 0;
  let outputTotal = 0;

  // One span per run (invoke_agent) with a chat span per model call and an execute_tool span per
  // tool call, following the OpenTelemetry GenAI conventions (semantic-conventions-genai v0.1.0,
  // status Development; DESIGN.md 2.8). With no SDK registered the tracer is a no-op.
  const tracer = trace.getTracer("triage-agent", "0.1.0");
  const rootSpan: Span = tracer.startSpan("invoke_agent triage-agent", {
    kind: SpanKind.INTERNAL,
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "triage-agent",
      ...opts.traceAttributes,
    },
  });
  const rootCtx = trace.setSpan(context.active(), rootSpan);
  const capture = opts.captureContent === true;
  const PROVIDER_NAME: Record<string, string> = { groq: "groq", gemini: "gcp.gemini" };

  const record = (s: Omit<StepRecord, "seq" | "budget">) => {
    const step: StepRecord = {
      ...s,
      seq: steps.length + 1,
      budget: { steps: budget.steps, toolCalls: budget.toolCalls, tokens: budget.tokens },
    };
    steps.push(step);
    if (s.kind === "validation") {
      const o = s.output as { ok: boolean; errors?: string[] };
      rootSpan.addEvent("validation", {
        "triage.validation.name": s.name,
        "triage.validation.ok": o.ok,
        ...(o.errors ? { "triage.validation.errors": o.errors.join(" | ") } : {}),
      });
    }
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
    const chat = tracer.startSpan(
      "chat",
      {
        kind: SpanKind.CLIENT,
        attributes: { "gen_ai.operation.name": "chat", "triage.stage": stage },
      },
      rootCtx,
    );
    try {
      res = await opts.router.complete({ system: prompt.forStage(stage), ...req });
    } catch (err) {
      chat.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message.slice(0, 200) });
      chat.setAttribute("error.type", (err as Error).name || "Error");
      chat.end();
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
    inputTotal += u.inputTokens;
    outputTotal += u.outputTokens + u.thinkingTokens;
    chat.updateName(`chat ${res.model}`);
    chat.setAttributes({
      "gen_ai.provider.name": PROVIDER_NAME[res.provider] ?? res.provider,
      "gen_ai.request.model": res.model,
      "gen_ai.response.model": res.model,
      "gen_ai.response.finish_reasons": [res.finishReason],
      "gen_ai.usage.input_tokens": u.inputTokens,
      "gen_ai.usage.output_tokens": u.outputTokens + u.thinkingTokens,
      "triage.usage.thinking_tokens": u.thinkingTokens,
      "triage.source": res.source,
      "triage.latency_ms": res.recordedLatencyMs ?? res.latencyMs,
      "triage.list_price_usd": res.listPriceUsd,
      "triage.tool_calls_requested": res.toolCalls.length,
    });
    if (capture) {
      chat.setAttribute("gen_ai.system_instructions", prompt.forStage(stage));
      chat.setAttribute("gen_ai.input.messages", JSON.stringify(req.messages));
      chat.setAttribute(
        "gen_ai.output.messages",
        JSON.stringify({ text: res.text, tool_calls: res.toolCalls }),
      );
    }
    chat.end();
    record({
      state,
      kind: "model_call",
      name: stage,
      ms: res.latencyMs,
      waitMs: res.waitMs,
      ...(res.recordedLatencyMs !== undefined ? { recordedMs: res.recordedLatencyMs } : {}),
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
      content: ticketMessage(ticket, { merchant: opts.tools.merchant, today: opts.today }),
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
    return parsed.ok
      ? validateDecision(parsed.decision, {
          citableClauseIds: citable,
          quarantinedClauseIds: quarantinedClauses,
          promptText,
          humanOnlyActions,
        })
      : parsed;
  };

  try {
    if (quarantined.notes.length)
      transition("quarantine", `ticket quarantined: ${quarantined.notes.join("; ")}`);

    // An unmistakable override attempt is REJECTed before any model call: the cheapest and the
    // safest answer, and one a clever prompt cannot talk the model out of.
    const markers = injectionMarkers(ticket.text);
    if (markers.length) {
      transition("quarantine", `rejected before any model call: ${markers.join(", ")}`);
      return finish(
        {
          decision: "REJECT",
          intent: "other",
          confidence: 1,
          facts_used: [],
          clause_ids: [],
          reply_draft: "",
          escalation_reason: "",
          missing_fields: [],
        },
        "quarantined",
        `ticket matched override markers: ${markers.join(", ")}`,
        false,
      );
    }

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
        await runTool(call);
      }
    }

    // RETRIEVE, by the machine: the model looked an order up but read no policy, so its reply
    // would have nothing to cite (measured 27 Nov: three cases decided from order facts alone,
    // and one was REJECTed with no policy in view). One search_policy call through MCP, like the
    // model's own; its results pass the same guard. Only runs that read no policy change.
    const query = citable.size ? null : machineQuery(ticket.text, orderStatus);
    if (query && !budget.blocksToolCall()) {
      transition("retrieve", `no policy read: the machine searches the policy for "${query}"`);
      const call = {
        id: "machine_retrieve",
        name: "search_policy",
        arguments: { query, top_k: 4 },
      };
      messages.push({ role: "assistant", content: "", toolCalls: [call] });
      await runTool(call);
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
    return finish(finalReply(decision), "decided", undefined, downgraded);
  } catch (err) {
    if (!(err instanceof StopRun)) {
      // A harness problem (a missing recording): close the span honestly, then fail loudly.
      rootSpan.recordException(err as Error);
      rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message.slice(0, 200),
      });
      rootSpan.end();
      throw err;
    }
    // Fail closed: a human gets the ticket with whatever was gathered.
    transition("escalate", `${err.exit} → escalate`);
    return finish(finalReply(failClosed(err.message)), err.exit, err.message, false);
  }

  async function runTool(call: { id: string; name: string; arguments: Record<string, unknown> }) {
    const state: State = call.name === "search_policy" ? "retrieve" : "gather";
    const t0 = performance.now();
    const toolSpan = tracer.startSpan(
      `execute_tool ${call.name}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": call.name,
          "gen_ai.tool.call.id": call.id,
          "gen_ai.tool.type": "function",
          ...(capture ? { "gen_ai.tool.call.arguments": JSON.stringify(call.arguments) } : {}),
        },
      },
      rootCtx,
    );
    const result = await opts.tools.call(call.name, call.arguments);
    budget.spendToolCall();
    const failed = result.structured.ok === false;
    toolSpan.setAttribute("triage.tool.ok", !failed);
    if (call.name === "search_policy" && Array.isArray(result.structured.results)) {
      toolSpan.setAttribute(
        "triage.clause_ids",
        (result.structured.results as { clause_id?: string }[]).flatMap((r) =>
          r.clause_id ? [r.clause_id] : [],
        ),
      );
    }
    if (failed) toolSpan.setAttribute("error.type", String(result.structured.code ?? "tool_error"));
    if (result.isError) toolSpan.setStatus({ code: SpanStatusCode.ERROR });
    if (capture)
      toolSpan.setAttribute("gen_ai.tool.call.result", JSON.stringify(result.structured));
    toolSpan.end();
    harvest(call.name, result.structured);
    // An order change the policy allows but no tool performs: a human must make it.
    const requested = String(call.arguments.request_type ?? "");
    if (
      call.name === "check_eligibility" &&
      result.structured.eligible === true &&
      (requested === "cancellation" || requested === "address_change")
    )
      humanOnlyActions.add(requested);
    record({
      state,
      kind: "tool_call",
      name: call.name,
      input: call.arguments,
      output: result.structured,
      ms: Math.round(performance.now() - t0),
    });
    const attached = policyTextFor(call.name, result.structured);
    if (attached.length)
      transition(
        "retrieve",
        `policy text attached to ${call.name}: ${attached.map((c) => c.clause_id).join(", ")}`,
      );
    // Tool results go back as tool messages, never into the system prompt.
    messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: modelView(call.name, result.structured, attached),
    });
  }

  function harvest(tool: string, s: Record<string, unknown>) {
    if (tool === "get_order" && s.ok !== false) {
      const status = (s.order as { status?: string } | undefined)?.status;
      if (status) orderStatus = status;
    }
    if (tool === "search_policy" && Array.isArray(s.results)) {
      for (const r of s.results as { clause_id?: string; text?: string }[]) {
        if (!r.clause_id) continue;
        // A clause that gives orders to the assistant is data: visible, but never citable.
        if (instructionLike(r.text ?? "")) {
          quarantinedClauses.add(r.clause_id);
          facts.push(`quarantined clause ${r.clause_id}`);
        } else citable.add(r.clause_id);
      }
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

  /**
   * The text of every clause a tool named by ID only (check_eligibility returns clause IDs, not
   * wording), plus the other clauses of the same policy document, so the model writes from the
   * policy itself: the return process, the refund timeline. Read from the MCP policy resources;
   * a clause that gives orders to the assistant is never attached. Attached clauses are citable:
   * the model has read them in this run.
   */
  function policyTextFor(tool: string, s: Record<string, unknown>) {
    if (tool !== "check_eligibility" || s.ok === false || !Array.isArray(s.clause_ids)) return [];
    const docs = new Set(
      (s.clause_ids as string[]).flatMap((id) => opts.tools.clauses.get(id)?.doc ?? []),
    );
    const attached = [...opts.tools.clauses.values()].filter(
      (c) => docs.has(c.doc) && !instructionLike(c.text),
    );
    for (const c of attached) citable.add(c.clause_id);
    return attached;
  }

  /**
   * Rules applied in code to the final decision (reply-rules.ts):
   *   - a ticket that describes a safety hazard is ESCALATEd, and its reply starts with the safety
   *     clause's instruction and cites that clause, whatever the model wrote;
   *   - clause IDs are removed from the reply text (they belong in clause_ids).
   * A REJECT is left alone: it sends nothing.
   */
  function finalReply(d: Decision): Decision {
    if (d.decision === "REJECT") return d;
    let out = d;
    const hazard = safetyHazard(ticket.text);
    const safety = opts.tools.clauses.get(SAFETY_CLAUSE);
    if (hazard && safety) {
      citable.add(SAFETY_CLAUSE);
      const reply = out.reply_draft.includes(SAFETY_NOTICE)
        ? out.reply_draft
        : `${SAFETY_NOTICE} ${out.reply_draft}`.trim();
      out = {
        ...out,
        decision: "ESCALATE",
        reply_draft: reply,
        clause_ids: out.clause_ids.includes(SAFETY_CLAUSE)
          ? out.clause_ids
          : [...out.clause_ids, SAFETY_CLAUSE],
        escalation_reason:
          out.decision === "ESCALATE" && out.escalation_reason.trim()
            ? out.escalation_reason
            : `Safety hazard reported ("${hazard}"): escalate at once with high priority (${SAFETY_CLAUSE}).`,
        missing_fields: [],
      };
      transition(
        "validate",
        `safety rule: hazard "${hazard}" → ESCALATE with the safety instruction`,
      );
    }
    const titles = new Map([...opts.tools.clauses.values()].map((c) => [c.clause_id, c.title]));
    const stripped = stripClauseIds(out.reply_draft, titles);
    if (stripped !== out.reply_draft) {
      out = { ...out, reply_draft: stripped };
      transition("validate", "removed clause IDs from the reply text");
    }
    return out;
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
    rootSpan.setAttributes({
      "gen_ai.usage.input_tokens": inputTotal,
      "gen_ai.usage.output_tokens": outputTotal,
      "triage.decision": decision.decision,
      "triage.intent": decision.intent,
      "triage.confidence": decision.confidence,
      "triage.exit": exit,
      "triage.repaired": repaired,
      "triage.downgraded": downgraded,
      "triage.budget.steps": budget.steps,
      "triage.budget.tool_calls": budget.toolCalls,
      "triage.budget.tokens": budget.tokens,
      "triage.list_price_usd": Math.round(listPrice * 1e10) / 1e10,
      "triage.prompt.version": prompt.version,
      "triage.prompt.hash": prompt.hash,
    });
    if (exit !== "decided") {
      // A safe ESCALATE, not a crash: the run ended early and a human gets what was gathered.
      rootSpan.setAttribute("error.type", exit);
      rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: exitReason?.slice(0, 200) ?? exit,
      });
    }
    rootSpan.end();
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
      quarantinedClauseIds: [...quarantinedClauses].sort(),
      traceId: rootSpan.spanContext().traceId,
    };
  }
}
