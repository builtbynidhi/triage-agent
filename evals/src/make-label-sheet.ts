/**
 * pnpm eval:labels
 *
 * Writes the 15 replies the owner hand-labels (spec, Phase 9): evals/labels/to-label.md (read this)
 * and evals/labels/judge-labels.yaml (fill this in). Replies come from the committed recordings, in
 * replay, so this makes no API call. The judge's score is never shown, so the labels are
 * independent of it. An existing judge-labels.yaml is never overwritten.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeRun } from "./grade.ts";
import { LABELS_FILE, pickForLabelling } from "./labels.ts";
import { loadCases } from "./load-cases.ts";
import { runSuite } from "./runner.ts";

const evalsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(evalsDir, "labels");
mkdirSync(outDir, { recursive: true });

const cases = loadCases().filter((c) => c.data.judge);
const byId = new Map(cases.map((c) => [c.data.id, c.data]));
const runs = await runSuite({ cases, repeats: 1, mode: "replay" });

const eligible = runs.flatMap((r) => {
  const c = byId.get(r.caseId);
  if (!c || !r.result) return [];
  const reply = r.result.decision.reply_draft.trim();
  if (!gradeRun(c, r.result).decision.ok || !reply) return [];
  return [{ caseId: c.id, rubric: c.judge!.rubric, ticket: c.ticket.text.trim(), reply }];
});
const picks = pickForLabelling(eligible, 15);
if (picks.length < 15) {
  console.error(
    `only ${picks.length} replies are eligible (a right decision and a reply to judge)`,
  );
}

const rubrics = [...new Set(picks.map((p) => p.rubric))].sort();
const rubricText = rubrics
  .map((r) => readFileSync(join(evalsDir, "rubrics", `${r}.md`), "utf8").trim())
  .join("\n\n---\n\n");

const sheet = `# Hand-label 15 replies

Read each reply and decide: **would you be happy to send it?** Judge it only against its rubric (below): tone, whether it answers, whether it asks only for what is missing. Do not check policy numbers; other tests do that.

- **pass**: you would send it (it would score 3 or better on the rubric).
- **fail**: you would not (it scores 1 or 2).

Put your answer in \`evals/labels/${LABELS_FILE}\`, one \`pass\` or \`fail\` per item. The judge's score is deliberately not shown here. Label from your own reading, then tell me when it is done.

## The rubrics

${rubricText}

---

${picks
  .map(
    (p, i) => `## Item ${i + 1}

**Rubric:** \`${p.rubric}\`

**The customer wrote:**

> ${p.ticket.replace(/\n/g, "\n> ")}

**The drafted reply:**

> ${p.reply.replace(/\n/g, "\n> ")}

**Your label (pass or fail):** ____
`,
  )
  .join("\n")}`;
writeFileSync(join(outDir, "to-label.md"), sheet);

const yamlPath = join(outDir, LABELS_FILE);
if (existsSync(yamlPath)) {
  console.error(`${LABELS_FILE} already exists: left untouched`);
} else {
  const body = picks
    .map((p, i) => `  - item: ${i + 1}\n    case_id: ${p.caseId}\n    label: ""\n    note: ""`)
    .join("\n");
  writeFileSync(
    yamlPath,
    `# Fill in label: pass or fail for each item, using evals/labels/to-label.md. Keep case_id as is.\nlabels:\n${body}\n`,
  );
}
console.error(`wrote ${picks.length} items to evals/labels/to-label.md`);
