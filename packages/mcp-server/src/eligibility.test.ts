import { describe, expect, it } from "vitest";
import { dateMinus, loadPolicies } from "@triage/data";
import { daysBetween, isIsoDate, todayInIndia } from "./dates.ts";
import {
  HIGH_VALUE_INR,
  REQUEST_TYPES,
  checkEligibility,
  type EligibilityFacts,
} from "./eligibility.ts";

const TODAY = "2026-11-20";
const delivered = (daysAgo: number, total = 2499): EligibilityFacts => ({
  status: "delivered",
  deliveredAt: dateMinus(daysAgo, TODAY),
  total,
  currency: "INR",
});

describe("return window (7 days, delivery day = day 0)", () => {
  it.each([
    [0, true],
    [1, true],
    [6, true],
    [7, true], // last allowed day: the off-by-one that wrongly refuses
    [8, false], // first refused day: the off-by-one that wrongly accepts
    [14, false],
    [30, false],
  ])("delivered %i days ago -> eligible %s", (days, eligible) => {
    const r = checkEligibility(delivered(days), "return", TODAY);
    expect(r.eligible).toBe(eligible);
    expect(r.clauseIds).toEqual(["returns.window"]);
    expect(r.reason).toContain(`day ${days}`);
  });
});

describe("refund window (14 days, but a refund needs a return accepted within 7)", () => {
  it.each([
    [0, true, ["refunds.window", "returns.window"]],
    [7, true, ["refunds.window", "returns.window"]],
    [8, false, ["refunds.window", "returns.window"]], // inside 14, but the return window has passed
    [13, false, ["refunds.window", "returns.window"]],
    [14, false, ["refunds.window", "returns.window"]], // last day of the 14-day window
    [15, false, ["refunds.window"]], // first day past it
  ])("delivered %i days ago -> eligible %s", (days, eligible, clauses) => {
    const r = checkEligibility(delivered(days), "refund", TODAY);
    expect(r.eligible).toBe(eligible);
    expect(r.clauseIds).toEqual(clauses);
  });

  it(`flags high value at exactly ${HIGH_VALUE_INR} INR, not one rupee below`, () => {
    const at = checkEligibility(delivered(3, HIGH_VALUE_INR), "refund", TODAY);
    const below = checkEligibility(delivered(3, HIGH_VALUE_INR - 1), "refund", TODAY);
    expect(at.clauseIds).toContain("refunds.high_value");
    expect(at.reason).toMatch(/manager approval/);
    expect(below.clauseIds).not.toContain("refunds.high_value");
  });
});

describe("status-driven rules", () => {
  const facts = (status: EligibilityFacts["status"]): EligibilityFacts => ({
    status,
    deliveredAt: status === "delivered" ? dateMinus(2, TODAY) : null,
    total: 2499,
    currency: "INR",
  });

  it.each([
    ["placed", "cancellation", true],
    ["dispatched", "cancellation", false],
    ["delivered", "cancellation", false],
    ["cancelled", "cancellation", false],
    ["placed", "address_change", true],
    ["dispatched", "address_change", false],
    ["placed", "return", false],
    ["dispatched", "return", false],
    ["cancelled", "return", false],
    ["returned", "return", false],
    ["cancelled", "refund", true],
    ["returned", "refund", true],
  ] as const)("%s order, %s -> eligible %s", (status, request, eligible) => {
    expect(checkEligibility(facts(status), request, TODAY).eligible).toBe(eligible);
  });

  it("every status x request x day returns real, citable clause IDs", () => {
    const real = new Set(loadPolicies().map((p) => p.clauseId));
    const statuses = ["placed", "dispatched", "delivered", "cancelled", "returned"] as const;
    for (const status of statuses) {
      for (const request of REQUEST_TYPES) {
        for (const days of [0, 7, 8, 14, 15]) {
          const r = checkEligibility(
            {
              ...facts(status),
              deliveredAt: status === "delivered" ? dateMinus(days, TODAY) : null,
            },
            request,
            TODAY,
          );
          expect(r.clauseIds.length).toBeGreaterThan(0);
          for (const id of r.clauseIds) expect(real, `${status}/${request}: ${id}`).toContain(id);
          expect(r.reason.length).toBeGreaterThan(10);
        }
      }
    }
  });
});

describe("bad data fails loudly instead of guessing", () => {
  it("a delivered order without a delivery date throws", () => {
    expect(() =>
      checkEligibility(
        { status: "delivered", deliveredAt: null, total: 1, currency: "INR" },
        "return",
        TODAY,
      ),
    ).toThrow(/no delivery date/);
  });
  it("a delivery date after today throws", () => {
    expect(() =>
      checkEligibility({ ...delivered(0), deliveredAt: "2026-11-21" }, "return", TODAY),
    ).toThrow(/after today/);
  });
});

describe("dates", () => {
  it("counts whole calendar days, across a month boundary", () => {
    expect(daysBetween("2026-11-13", "2026-11-20")).toBe(7);
    expect(daysBetween("2026-10-31", "2026-11-01")).toBe(1);
    expect(daysBetween("2026-11-20", "2026-11-20")).toBe(0);
  });
  it("validates real calendar dates only", () => {
    expect(isIsoDate("2026-11-20")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("20-11-2026")).toBe(false);
  });
  it("uses India's date, not the server's: 20:00 UTC is already tomorrow in IST", () => {
    expect(todayInIndia(new Date("2026-11-20T20:00:00Z"))).toBe("2026-11-21");
    expect(todayInIndia(new Date("2026-11-20T10:00:00Z"))).toBe("2026-11-20");
  });
});
