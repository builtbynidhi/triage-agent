import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { CASES_DIR } from "./load-cases.ts";
import { SCHEMA_PATH } from "./write-schema.ts";

/**
 * Validates every case file against the committed case.schema.json, independently of Zod.
 * This proves the generated JSON Schema is usable by editors and other tools, not just
 * that it matches the Zod source. Cross-field rules (e.g. NEEDS_INFO needs missing_fields)
 * cannot be expressed in JSON Schema and are enforced by the Zod schema in cases.test.ts.
 */
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));
const files = readdirSync(CASES_DIR)
  .filter((f) => f.endsWith(".yaml"))
  .sort();

describe("case files against case.schema.json (ajv)", () => {
  it("finds all 40 case files", () => expect(files).toHaveLength(40));

  for (const f of files) {
    it(f, () => {
      const ok = validate(parse(readFileSync(join(CASES_DIR, f), "utf8")));
      expect(validate.errors ?? [], ajv.errorsText(validate.errors)).toEqual([]);
      expect(ok).toBe(true);
    });
  }

  it("rejects an invalid case, so the schema is not vacuous", () => {
    expect(validate({ id: "Bad Id", category: "normal" })).toBe(false);
    expect(
      validate({ ...parse(readFileSync(join(CASES_DIR, files[0]!), "utf8")), surprise: 1 }),
    ).toBe(false);
  });
});
