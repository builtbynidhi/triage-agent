/**
 * Per-run ceilings. Spec: 8 steps, 6 tool calls, and a token ceiling; hitting any one ends the
 * run at ESCALATE with whatever facts were gathered.
 *
 * What a step is: one unit of real work, either a model call or a tool call (a tool call spends a
 * step AND a tool call). Bookkeeping transitions (validate, propose, close) are recorded in the
 * step record but cost nothing. Read literally ("every transition spends a step"), the seven
 * states alone would use 7 of the 8 steps before any tool ran, so no ticket could finish; see
 * docs/adr/0001-state-machine-not-a-framework.md.
 */
export interface BudgetLimits {
  maxSteps: number;
  maxToolCalls: number;
  /** Input + output + thinking tokens across every model call in the run. */
  maxTokens: number;
}

export const DEFAULT_BUDGET: BudgetLimits = { maxSteps: 8, maxToolCalls: 6, maxTokens: 24_000 };

export type BudgetExhausted = "steps" | "tool_calls" | "tokens";

export class Budget {
  readonly limits: BudgetLimits;
  steps = 0;
  toolCalls = 0;
  tokens = 0;

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = { ...DEFAULT_BUDGET, ...limits };
  }

  /** Why the next model call cannot happen, or null if it can. */
  blocksModelCall(): BudgetExhausted | null {
    if (this.steps + 1 > this.limits.maxSteps) return "steps";
    if (this.tokens >= this.limits.maxTokens) return "tokens";
    return null;
  }

  /** Why the next tool call cannot happen, or null if it can. */
  blocksToolCall(): BudgetExhausted | null {
    if (this.steps + 1 > this.limits.maxSteps) return "steps";
    if (this.toolCalls + 1 > this.limits.maxToolCalls) return "tool_calls";
    return null;
  }

  spendModelCall(tokens: number): void {
    this.steps++;
    this.tokens += tokens;
  }

  spendToolCall(): void {
    this.steps++;
    this.toolCalls++;
  }

  /** True once the token ceiling has been crossed (checked after each model call). */
  overTokens(): boolean {
    return this.tokens > this.limits.maxTokens;
  }

  snapshot() {
    return {
      steps: this.steps,
      toolCalls: this.toolCalls,
      tokens: this.tokens,
      limits: this.limits,
    };
  }
}
