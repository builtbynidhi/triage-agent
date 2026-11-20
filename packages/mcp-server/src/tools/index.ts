import type { ToolDefinition } from "../registry.ts";
import { checkEligibility } from "./check-eligibility.ts";
import { getCustomer } from "./get-customer.ts";
import { getOrder } from "./get-order.ts";
import { searchPolicy } from "./search-policy.ts";

/** The read-only tools. The two write tools (approval-gated) are added in Phase 10. */
export const READ_TOOLS = [
  searchPolicy,
  getOrder,
  getCustomer,
  checkEligibility,
] as unknown as readonly ToolDefinition[];

export { checkEligibility, getCustomer, getOrder, searchPolicy };
