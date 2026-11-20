import { describe, expect, it } from "vitest";
import { maskEmail, maskPhone } from "./pii.ts";

describe("maskEmail", () => {
  it.each([
    ["asha.sharma1@example.com", "a***1@example.com"],
    ["ab@example.com", "a***@example.com"],
    ["x@example.com", "x***@example.com"],
    ["not-an-email", "***"],
    ["@example.com", "***"],
  ])("%s -> %s", (input, expected) => expect(maskEmail(input)).toBe(expected));

  it("never reveals the local part beyond its first and last character", () => {
    const masked = maskEmail("meera.patel5@example.com");
    expect(masked).not.toContain("meera");
    expect(masked).not.toContain("patel");
  });
});

describe("maskPhone", () => {
  it.each([
    ["+91 9107654321", "+91 ******4321"],
    ["+91-91076-54321", "+91 ******4321"],
    ["9107654321", "******4321"],
    ["123", "****"],
  ])("%s -> %s", (input, expected) => expect(maskPhone(input)).toBe(expected));

  it("keeps only the last four digits of the national number", () => {
    const masked = maskPhone("+91 9138271605");
    expect(masked.replace(/\D/g, "")).toBe("911605"); // country code + last four
    expect(masked).not.toContain("913827");
  });
});
