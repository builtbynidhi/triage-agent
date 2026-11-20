import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { CaseSchema, type EvalCase } from "./case-schema.ts";

export const CASES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../cases");

export interface LoadedCase {
  file: string;
  data: EvalCase;
}

/** Parse and validate every case. Throws one error listing every invalid file. */
export function loadCases(dir: string = CASES_DIR): LoadedCase[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  const errors: string[] = [];
  const cases: LoadedCase[] = [];
  for (const f of files) {
    const result = CaseSchema.safeParse(parse(readFileSync(join(dir, f), "utf8")));
    if (!result.success) {
      errors.push(
        `${f}:\n` +
          result.error.issues
            .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("\n"),
      );
      continue;
    }
    if (result.data.id !== basename(f, ".yaml")) {
      errors.push(`${f}: id "${result.data.id}" does not match the file name`);
    }
    cases.push({ file: f, data: result.data });
  }
  if (errors.length) throw new Error(`Invalid eval cases:\n${errors.join("\n")}`);
  return cases;
}
