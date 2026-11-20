import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Db } from "./sqlite/db.ts";

export interface PolicyChunk {
  clauseId: string;
  doc: string;
  title: string;
  text: string;
}

export function defaultPoliciesDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../policies");
}

/** Parse one policy file: YAML frontmatter lists clauses; body has one `## <clause_id>` section each. */
export function parsePolicyFile(source: string, fileName = "policy"): PolicyChunk[] {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!m) throw new Error(`${fileName}: missing frontmatter`);
  const meta = parse(m[1]!) as { doc: string; clauses: { id: string; title: string }[] };
  const sections = new Map<string, string>();
  for (const part of m[2]!.split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    sections.set(part.slice(0, nl).trim(), part.slice(nl + 1).trim());
  }
  const declared = meta.clauses.map((c) => c.id);
  for (const id of sections.keys()) {
    if (!declared.includes(id)) throw new Error(`${fileName}: section "${id}" not in frontmatter`);
  }
  return meta.clauses.map((c) => {
    const text = sections.get(c.id);
    if (!text) throw new Error(`${fileName}: clause "${c.id}" has no section`);
    return { clauseId: c.id, doc: meta.doc, title: c.title, text };
  });
}

/** Load every policy file, in filename order, so results are deterministic. */
export function loadPolicies(dir: string = defaultPoliciesDir()): PolicyChunk[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => parsePolicyFile(readFileSync(join(dir, f), "utf8"), f));
}

/** (Re)build policy_chunks and the FTS5 index. Vectors are added by the retrieval phase. */
export function indexPolicies(db: Db, chunks: PolicyChunk[]): void {
  db.transaction(() => {
    db.exec("DELETE FROM policy_chunks; DELETE FROM policy_fts;");
    const ins = db.prepare(
      "INSERT INTO policy_chunks (clause_id, doc, title, text) VALUES (?,?,?,?)",
    );
    const fts = db.prepare("INSERT INTO policy_fts (clause_id, title, text) VALUES (?,?,?)");
    for (const c of chunks) {
      ins.run(c.clauseId, c.doc, c.title, c.text);
      fts.run(c.clauseId, c.title, c.text);
    }
  })();
}
