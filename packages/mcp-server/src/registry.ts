import type { McpServer } from "@modelcontextprotocol/server";
import type { PolicyHit, TriageStore } from "@triage/data";
import type { z } from "zod";
import { ToolFailure, toolError, type ToolError } from "./errors.ts";

/**
 * Everything a tool may use. The tenant and the clock are fixed when the server is built,
 * by the transport (env var for stdio, request header for HTTP until Phase 10's JWT).
 * They are never tool inputs, so no ticket text can steer a tool to another tenant or date.
 */
export interface ToolContext {
  store: TriageStore;
  tenantId: string;
  /** The merchant's display name, e.g. "Kaveri Home & Kitchen". */
  tenantName: string;
  /** Today's date, YYYY-MM-DD. Injected so evals pin it to the seed date. */
  today: () => string;
  /** Policy retrieval. Keyword search now; Phase 4 swaps in hybrid search behind the same signature. */
  searchPolicies: (query: string, limit: number) => Promise<PolicyHit[]>;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** All four read tools: no side effects, safe to repeat, and nothing reaches the internet. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: I;
  /** Schema of a successful result. Every success carries `ok: true`; failures are ToolError. */
  output: O;
  annotations: ToolAnnotations;
  run(input: z.output<I>, ctx: ToolContext): Promise<z.input<O> | ToolError>;
}

export const defineTool = <I extends z.ZodType, O extends z.ZodType>(
  def: ToolDefinition<I, O>,
): ToolDefinition<I, O> => def;

export type ToolOutcome =
  | { isError: false; structuredContent: Record<string, unknown> }
  | { isError: true; structuredContent: ToolError };

const formatIssues = (issues: z.core.$ZodIssue[]) =>
  issues.map((i) => `${i.path.length ? i.path.join(".") : "(input)"}: ${i.message}`).join("; ");

/**
 * Run one tool: validate input, run, validate output, and turn every failure into the shared
 * error shape. MCP calls and unit tests both go through here, so they cannot drift apart.
 */
export async function invokeTool(
  def: ToolDefinition,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      structuredContent: toolError("invalid_input", formatIssues(parsed.error.issues)),
    };
  }
  try {
    const out = (await def.run(parsed.data, ctx)) as { ok?: unknown };
    if (out.ok === false) return { isError: true, structuredContent: out as ToolError };
    // Our own output is checked too: a malformed success is a bug, never sent as if it were fine.
    return { isError: false, structuredContent: def.output.parse(out) as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ToolFailure)
      return { isError: true, structuredContent: toolError(err.code, err.message) };
    // Internal detail stays in the server log, never in the result the model sees.
    console.error(`[mcp-server] ${def.name} failed:`, err);
    return {
      isError: true,
      structuredContent: toolError("upstream_error", `${def.name} failed internally; try again.`),
    };
  }
}

/**
 * Advertise the strict schema to clients, but let every input through to invokeTool.
 *
 * Why: when input fails its schema, the SDK (v2.4) replies with a free-text error
 * ("Input validation error: ..."). The agent must branch on a code, not parse prose, so we
 * validate ourselves and return `invalid_input` in the shared shape. Clients still see the
 * complete JSON Schema, because it comes from the strict schema's own `~standard.jsonSchema`.
 */
function advertiseOnly(schema: z.ZodType): z.ZodType {
  const wrapper = {
    "~standard": {
      version: 1,
      vendor: "triage-agent",
      validate: (value: unknown) => ({ value }),
      jsonSchema: schema["~standard"].jsonSchema,
    },
  };
  return wrapper as unknown as z.ZodType;
}

export function registerTools(
  server: McpServer,
  tools: readonly ToolDefinition[],
  ctx: ToolContext,
): void {
  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: advertiseOnly(def.input),
        outputSchema: def.output,
        annotations: def.annotations,
      },
      async (args: unknown) => {
        const outcome = await invokeTool(def, args, ctx);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(outcome.structuredContent) }],
          structuredContent: outcome.structuredContent,
          isError: outcome.isError,
        };
      },
    );
  }
}
