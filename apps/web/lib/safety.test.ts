import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Model replies and customer tickets are untrusted text, and the UI shows them. React escapes
 * everything it renders, so the one way to turn text into markup is to bypass it. This test fails
 * if any source file does (SECURITY.md, LLM10 Improper Output Handling).
 */
const root = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === ".next" || f === "data") return [];
    return statSync(p).isDirectory()
      ? files(p)
      : /\.(tsx?|jsx?)$/.test(f) && !f.endsWith(".test.ts")
        ? [p]
        : [];
  });

describe("the web app never turns text into markup", () => {
  const sources = files(root);
  it("has source files to check", () => expect(sources.length).toBeGreaterThan(10));
  it("uses no dangerouslySetInnerHTML, innerHTML, document.write or eval", () => {
    for (const f of sources) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(
        /dangerouslySetInnerHTML|\.innerHTML|insertAdjacentHTML|document\.write|\beval\(/,
      );
    }
  });
  it("never sends the API token to the browser: only server files read it", () => {
    for (const f of sources) {
      const text = readFileSync(f, "utf8");
      if (text.includes("TRIAGE_API_TOKEN")) expect(text, f).not.toMatch(/^"use client"/m);
    }
  });
});
