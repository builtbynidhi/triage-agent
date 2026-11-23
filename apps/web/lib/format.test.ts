import { describe, expect, it } from "vitest";
import { excerpt, fmtMs, fmtTokens, fmtUsd, median, pct } from "./format";

describe("formatting", () => {
  it("shows durations in the unit a person reads", () => {
    expect(fmtMs(0)).toBe("0 ms");
    expect(fmtMs(412.4)).toBe("412 ms");
    expect(fmtMs(1500)).toBe("1.5 s");
    expect(fmtMs(26466)).toBe("26 s");
    expect(fmtMs(76769)).toBe("1 min 17 s");
    expect(fmtMs(Number.NaN)).toBe("n/a");
  });
  it("shows list-price cost with enough digits for a fraction of a cent", () => {
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(0.00734625)).toBe("$0.0073");
    expect(fmtUsd(1.2)).toBe("$1.20");
  });
  it("tokens, percentages, excerpts and medians", () => {
    expect(fmtTokens(5950)).toBe("5950");
    expect(fmtTokens(174600)).toBe("174.6k");
    expect(pct(81, 117)).toBe("69.2%");
    expect(pct(0, 0)).toBe("n/a");
    expect(excerpt("a   b\n c", 20)).toBe("a b c");
    expect(excerpt("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
