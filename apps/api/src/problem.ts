import type { Response } from "express";

/**
 * Errors are RFC 9457 "problem details": a status, a short title and a detail, as
 * application/problem+json. Never a stack trace, and never a different message for "missing" and
 * "not yours".
 */
export function problem(res: Response, status: number, title: string, detail?: string): void {
  res
    .status(status)
    .type("application/problem+json")
    .json({ type: "about:blank", title, status, ...(detail ? { detail } : {}) });
}
