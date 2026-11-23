import type { RunResult } from "./machine.ts";

/**
 * What a failed run keeps, so it can be triaged without re-running it (spec, Phase 11): the
 * prompt that was used, every validation outcome, how much budget was spent at exit, which
 * clauses had been retrieved, and why the run ended. Used by the eval report and the worker.
 */
export interface FailureDetail {
  promptHash: string;
  validation: unknown[];
  budgetAtExit: RunResult["usage"];
  retrievedClauseIds: string[];
  exit: RunResult["exit"];
  exitReason: string | null;
}

export function failureDetail(r: RunResult): FailureDetail {
  return {
    promptHash: r.prompt.hash,
    validation: r.steps.filter((s) => s.kind === "validation").map((s) => s.output),
    budgetAtExit: r.usage,
    retrievedClauseIds: r.citableClauseIds,
    exit: r.exit,
    exitReason: r.exitReason ?? null,
  };
}
