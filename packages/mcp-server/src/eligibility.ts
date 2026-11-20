import { daysBetween } from "./dates.ts";

/**
 * Eligibility is plain code, never a model call. Refund and return windows are arithmetic,
 * so the answer is deterministic, unit-tested at every boundary, and auditable.
 * The model reads the messy ticket and writes the reply; it never decides whether
 * a refund is in policy. See docs/adr/0004-eligibility-is-code.md.
 *
 * The rules mirror policies/*.md. Each result names the clause IDs that justify it,
 * and the reply must cite them.
 */

export const RETURN_WINDOW_DAYS = 7; // returns.window: delivery day is day 0, day 7 is the last day
export const REFUND_WINDOW_DAYS = 14; // refunds.window
export const HIGH_VALUE_INR = 10_000; // refunds.high_value

export const REQUEST_TYPES = ["return", "refund", "cancellation", "address_change"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/** Only the order facts the rules need. Deliberately no customer data. */
export interface EligibilityFacts {
  status: "placed" | "dispatched" | "delivered" | "cancelled" | "returned";
  deliveredAt: string | null;
  total: number;
  currency: string;
}

export interface Eligibility {
  eligible: boolean;
  reason: string;
  clauseIds: string[];
}

const result = (eligible: boolean, reason: string, ...clauseIds: string[]): Eligibility => ({
  eligible,
  reason,
  clauseIds,
});

function deliveredDay(facts: EligibilityFacts, today: string): number {
  if (!facts.deliveredAt) throw new Error("delivered order has no delivery date");
  const day = daysBetween(facts.deliveredAt, today);
  if (day < 0) throw new Error(`delivery date ${facts.deliveredAt} is after today ${today}`);
  return day;
}

function returnRule(f: EligibilityFacts, today: string): Eligibility {
  switch (f.status) {
    case "placed":
      return result(
        false,
        "Not dispatched yet, so there is nothing to return; it can be cancelled free of charge instead.",
        "cancellation.before_dispatch",
      );
    case "dispatched":
      return result(
        false,
        "In transit. A return can start after delivery, or the customer can refuse delivery at the door.",
        "cancellation.after_dispatch",
      );
    case "cancelled":
      return result(
        false,
        "The order was cancelled, so nothing was delivered.",
        "cancellation.refund",
      );
    case "returned":
      return result(
        false,
        "The order has already been returned; its refund follows quality check.",
        "refunds.timeline",
      );
    case "delivered": {
      const day = deliveredDay(f, today);
      return day <= RETURN_WINDOW_DAYS
        ? result(
            true,
            `Delivered ${f.deliveredAt}; today (${today}) is day ${day} of the ${RETURN_WINDOW_DAYS}-day return window, counting the delivery day as day 0.`,
            "returns.window",
          )
        : result(
            false,
            `Delivered ${f.deliveredAt}; today (${today}) is day ${day}, past the ${RETURN_WINDOW_DAYS}-day return window.`,
            "returns.window",
          );
    }
  }
}

function refundRule(f: EligibilityFacts, today: string): Eligibility {
  switch (f.status) {
    case "placed":
      return result(
        false,
        "Not dispatched yet. Cancelling it refunds a prepaid order in full.",
        "cancellation.before_dispatch",
        "cancellation.refund",
      );
    case "dispatched":
      return result(
        false,
        "In transit. A refund needs the item delivered and then returned.",
        "cancellation.after_dispatch",
      );
    case "cancelled":
      return result(
        true,
        "Cancelled before dispatch: a prepaid order is refunded in full within 3 to 5 business days.",
        "cancellation.refund",
      );
    case "returned":
      return result(
        true,
        "Already returned; the refund is processed after quality check.",
        "refunds.timeline",
      );
    case "delivered": {
      const day = deliveredDay(f, today);
      if (day > REFUND_WINDOW_DAYS) {
        return result(
          false,
          `Delivered ${f.deliveredAt}; today (${today}) is day ${day}, past the ${REFUND_WINDOW_DAYS}-day refund window.`,
          "refunds.window",
        );
      }
      if (day > RETURN_WINDOW_DAYS) {
        return result(
          false,
          `Delivered ${f.deliveredAt}; today (${today}) is day ${day}. A refund for a returned item needs the return accepted inside the ${RETURN_WINDOW_DAYS}-day return window, which has passed.`,
          "refunds.window",
          "returns.window",
        );
      }
      const base = `Delivered ${f.deliveredAt}; today (${today}) is day ${day}, inside the ${RETURN_WINDOW_DAYS}-day return window. The refund follows an accepted return.`;
      return f.total >= HIGH_VALUE_INR
        ? result(
            true,
            `${base} The order total is ${f.total} ${f.currency}: a refund of ${HIGH_VALUE_INR} INR or more needs manager approval, so escalate it.`,
            "refunds.window",
            "returns.window",
            "refunds.high_value",
          )
        : result(true, base, "refunds.window", "returns.window");
    }
  }
}

function cancellationRule(f: EligibilityFacts): Eligibility {
  switch (f.status) {
    case "placed":
      return result(
        true,
        "Not dispatched yet, so it can be cancelled free of charge.",
        "cancellation.before_dispatch",
      );
    case "cancelled":
      return result(false, "The order is already cancelled.", "cancellation.refund");
    case "dispatched":
    case "delivered":
    case "returned":
      return result(
        false,
        "Already dispatched, so it cannot be cancelled; the customer can refuse delivery or return it.",
        "cancellation.after_dispatch",
      );
  }
}

function addressRule(f: EligibilityFacts): Eligibility {
  switch (f.status) {
    case "placed":
      return result(
        true,
        "Not dispatched yet, so the address can be changed once, free of charge, given a complete new address.",
        "address.before_dispatch",
        "address.requirements",
      );
    case "cancelled":
      return result(
        false,
        "The order is cancelled, so there is no delivery to redirect.",
        "address.after_dispatch",
      );
    case "dispatched":
    case "delivered":
    case "returned":
      return result(
        false,
        "Already dispatched, so the address cannot be changed.",
        "address.after_dispatch",
      );
  }
}

export function checkEligibility(
  facts: EligibilityFacts,
  request: RequestType,
  today: string,
): Eligibility {
  switch (request) {
    case "return":
      return returnRule(facts, today);
    case "refund":
      return refundRule(facts, today);
    case "cancellation":
      return cancellationRule(facts);
    case "address_change":
      return addressRule(facts);
  }
}
