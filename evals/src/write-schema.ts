import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CaseSchema } from "./case-schema.ts";

export const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../case.schema.json");

/** JSON Schema for the case format, for editors and other tools. Generated, never hand-edited. */
export function caseJsonSchema(): string {
  const schema = z.toJSONSchema(CaseSchema, { io: "input" });
  return (
    JSON.stringify(
      {
        ...schema,
        title: "triage-agent eval case",
        $comment: "Generated from evals/src/case-schema.ts. Do not edit.",
      },
      null,
      2,
    ) + "\n"
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(SCHEMA_PATH, caseJsonSchema());
  console.log(`wrote ${SCHEMA_PATH}`);
}
