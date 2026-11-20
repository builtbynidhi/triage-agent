import { z } from "zod";

/**
 * The one error shape every tool returns. No free-text errors: the agent branches on `code`
 * and `retryable`, never on message wording.
 */
export const ERROR_CODES = [
  "not_found",
  "invalid_input",
  "forbidden",
  "rate_limited",
  "upstream_error",
  "needs_approval",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Only these are worth retrying, and a retry costs the agent a step from its budget. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["rate_limited", "upstream_error"]);

export const ToolErrorSchema = z
  .object({
    ok: z.literal(false),
    code: z.enum(ERROR_CODES),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();

export type ToolError = z.infer<typeof ToolErrorSchema>;

export function toolError(code: ErrorCode, message: string): ToolError {
  return { ok: false, code, message, retryable: RETRYABLE.has(code) };
}

/** Throw from deep inside a handler to return a specific code; anything else becomes upstream_error. */
export class ToolFailure extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
  }
}

/** One message for "missing" and "another tenant's", so a reply can never confirm existence. */
export const ORDER_NOT_FOUND = "No order with that ID for this tenant.";
export const CUSTOMER_NOT_FOUND = "No customer with that ID or email for this tenant.";
