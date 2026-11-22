import type { JsonSchema } from "./types.ts";

/**
 * Gemini's function `parameters` take an OpenAPI-style subset of JSON Schema. Keep only the
 * keywords that subset understands, and turn `type: ["string", "null"]` into
 * `type: "string", nullable: true`. Anything else (e.g. `$schema`, `additionalProperties`,
 * `pattern`) is dropped, never sent.
 */
const GEMINI_KEYS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "enum",
  "items",
  "format",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "nullable",
  "anyOf",
]);

export function toGeminiParameters(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!GEMINI_KEYS.has(k)) continue;
    if (k === "type" && Array.isArray(v)) {
      const types = v.filter((t) => t !== "null");
      out.type = types[0];
      if (types.length !== v.length) out.nullable = true;
    } else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, JsonSchema>).map(([p, s]) => [p, toGeminiParameters(s)]),
      );
    } else if (k === "items" && v && typeof v === "object") {
      out.items = toGeminiParameters(v as JsonSchema);
    } else if (k === "anyOf" && Array.isArray(v)) {
      out.anyOf = v.map((s) => toGeminiParameters(s as JsonSchema));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Strip keys no response-schema endpoint needs (`$schema`, `$id`). */
export function withoutMeta(schema: JsonSchema): JsonSchema {
  return Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$schema" && k !== "$id"));
}

/**
 * Groq's strict structured outputs require every property to be required and every object to
 * set additionalProperties: false. When a schema qualifies, use strict mode; otherwise fall
 * back to best effort rather than send a schema the API would reject.
 */
export function isStrictCompatible(schema: JsonSchema): boolean {
  if (schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"))) {
    const props = Object.keys((schema.properties as Record<string, unknown>) ?? {});
    const required = new Set((schema.required as string[]) ?? []);
    if (schema.additionalProperties !== false) return false;
    if (!props.every((p) => required.has(p))) return false;
    return Object.values((schema.properties as Record<string, JsonSchema>) ?? {}).every(
      isStrictCompatible,
    );
  }
  if (schema.items) return isStrictCompatible(schema.items as JsonSchema);
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as JsonSchema[]).every(isStrictCompatible);
  return true;
}
