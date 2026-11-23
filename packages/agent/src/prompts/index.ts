import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The system prompt lives in a versioned markdown file (system.vN.md), not an inline string, so
 * every change shows up in a diff. A new version gets a new file; the version and a content hash
 * go into each run's step record, so a score can always be traced to the exact prompt.
 */
export const PROMPT_FILE = "system.v2.md";

export type PromptStage = "classify" | "gather" | "decide" | "repair";

export interface SystemPrompt {
  version: string;
  /** sha256 of the whole file, first 12 hex characters. */
  hash: string;
  forStage(stage: PromptStage): string;
}

export function loadSystemPrompt(file = PROMPT_FILE): SystemPrompt {
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");
  // Sections are introduced by marker lines such as <!-- @gather -->.
  const sections = new Map<string, string>();
  const markers = [...text.matchAll(/^<!-- @(\w+) -->\s*$/gm)];
  markers.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = markers[i + 1]?.index ?? text.length;
    sections.set(m[1]!, text.slice(start, end).trim());
  });
  const shared = sections.get("shared");
  if (!shared) throw new Error(`${file}: missing <!-- @shared --> section`);
  for (const s of ["classify", "gather", "decide", "repair"] as const) {
    if (!sections.get(s)) throw new Error(`${file}: missing <!-- @${s} --> section`);
  }
  return {
    version: file.replace(/\.md$/, ""),
    hash: createHash("sha256").update(text).digest("hex").slice(0, 12),
    forStage: (stage) => `${shared}\n\n${sections.get(stage)}`,
  };
}
