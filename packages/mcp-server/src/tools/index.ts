import type { ToolDefinition } from "../registry.ts";
import { checkEligibility } from "./check-eligibility.ts";
import { createEscalation } from "./create-escalation.ts";
import { getCustomer } from "./get-customer.ts";
import { getOrder } from "./get-order.ts";
import { searchPolicy } from "./search-policy.ts";
import { sendReply } from "./send-reply.ts";

/** The four read-only tools: all a transport without an approval store offers. */
export const READ_TOOLS = [
  searchPolicy,
  getOrder,
  getCustomer,
  checkEligibility,
] as unknown as readonly ToolDefinition[];

/** The two write tools. Each refuses unless a reviewer has approved exactly what it is asked to do. */
export const WRITE_TOOLS = [createEscalation, sendReply] as unknown as readonly ToolDefinition[];

/** All six tools, from one registry. */
export const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS] as readonly ToolDefinition[];

export { checkEligibility, createEscalation, getCustomer, getOrder, searchPolicy, sendReply };
