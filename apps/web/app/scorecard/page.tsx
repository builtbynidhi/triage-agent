import { getScorecard } from "@/lib/data";
import { fmtMs, pct } from "@/lib/format";

export const metadata = { title: "Scorecard" };

interface Ratio {
  n: number;
  of: number;
}

const isRatio = (x: unknown): x is Ratio =>
  typeof x === "object" &&
  x !== null &&
  typeof (x as Ratio).n === "number" &&
  typeof (x as Ratio).of === "number";
const ratio = (x: unknown): Ratio => (isRatio(x) ? x : { n: 0, of: 0 });
const num = (x: unknown): number | null => (typeof x === "number" ? x : null);
const obj = (x: unknown): Record<string, unknown> =>
  typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};

export default function ScorecardPage() {
  const { meta, card, cases } = getScorecard();
  const groups = obj(card.byGroup);
  const latency = obj(card.latencyMs);
  const tools = obj(card.toolCallsPerRun);
  const runs = obj(card.runs);
  const judgeAgreement = card.judgeAgreement;
  const judge = obj(card.judge);
  const judged = ratio(judge.judged);
  const judgeMean = num(judge.meanScore);
  const judgeLine = judged.of
    ? `${judged.n}/${judged.of} pass${judgeMean === null ? "" : `, mean ${judgeMean.toFixed(2)}`}`
    : "not run";
  const ai = card.judgeAgreementAi;
  const aiLine = isRatio(ai)
    ? `An AI second reviewer agrees ${ai.n} of ${ai.of} times (a sanity check, not a human).`
    : "";
  const failing = cases.filter((c) => c.scored > 0 && c.passed < c.scored);

  const rows: [string, string, string?][] = [
    [
      "Decision accuracy",
      pct(ratio(card.decisionAccuracy).n, ratio(card.decisionAccuracy).of),
      "the agent made the decision the case expects",
    ],
    [
      "Citation accuracy",
      pct(ratio(card.citationAccuracy).n, ratio(card.citationAccuracy).of),
      "of AUTO_REPLY runs: every required clause cited, none invented",
    ],
    [
      "Escalation precision",
      pct(ratio(card.escalationPrecision).n, ratio(card.escalationPrecision).of),
      "of runs that escalated, the share that should have",
    ],
    [
      "Escalation recall",
      pct(ratio(card.escalationRecall).n, ratio(card.escalationRecall).of),
      "of cases that should escalate, the share that did",
    ],
    [
      "Injection resistance",
      pct(ratio(card.injectionResistance).n, ratio(card.injectionResistance).of),
      "adversarial cases that held on every repeat",
    ],
    [
      "Repair rate",
      pct(ratio(card.repairRate).n, ratio(card.repairRate).of),
      "runs that needed the one repair attempt",
    ],
    [
      "Latency p50 / p95",
      `${fmtMs(num(latency.p50) ?? NaN)} / ${fmtMs(num(latency.p95) ?? NaN)}`,
      "recorded provider latency plus tool time",
    ],
    [
      "Tokens per run (mean)",
      num(obj(card.tokensPerRun).mean) === null
        ? "n/a"
        : String(Math.round(num(obj(card.tokensPerRun).mean)!)),
    ],
    [
      "Tool calls per run (mean / max)",
      `${num(tools.mean)?.toFixed(1) ?? "n/a"} / ${num(tools.max) ?? "n/a"}`,
    ],
    [
      "Cost per 100 tickets",
      num(card.listPriceUsdPer100) === null
        ? "n/a"
        : `$${num(card.listPriceUsdPer100)!.toFixed(2)} at list price`,
      "actual cost: $0 on the free tiers",
    ],
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Scorecard</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          The eval suite&rsquo;s own report (<code>evals/report/report.json</code>): 40 hand-written
          cases, each run {String(meta.repeats ?? 3)} times, replayed from recorded model answers.
          Every number is measured; none is a target. Run on {String(meta.date ?? "?")} with prompt{" "}
          <code>
            {typeof meta.prompt === "object" && meta.prompt
              ? `${(meta.prompt as { version?: string }).version}#${(meta.prompt as { hash?: string }).hash}`
              : "?"}
          </code>
          .
        </p>
        <p className="mt-2 max-w-3xl rounded border border-line bg-surface px-3 py-2 text-sm text-muted">
          <strong className="text-fg">How complete is this?</strong> It includes the Phase 9 input
          guards and the judge scores recorded so far. Six cases are not scored yet: five are
          waiting for a judge recording and one cannot be answered by the model (see the table
          below).
        </p>
      </div>

      <section aria-labelledby="headline">
        <h2 id="headline" className="sr-only">
          Pass rate
        </h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <Big label="Overall pass rate" r={ratio(card.passRate)} />
          {(["normal", "edge", "adversarial"] as const).map((g) => (
            <Big key={g} label={g} r={ratio(groups[g])} />
          ))}
        </div>
        <p className="mt-3 max-w-3xl text-sm text-muted">
          A run passes only if the decision matches, the right clauses are cited (none forbidden or
          invented) and the reply has the required facts.{" "}
          {Number(runs.incomplete ?? 0) > 0 &&
            `${runs.incomplete} run(s) could not be scored (no recording) and are left out, not counted as passes. `}
          The agent is <strong>untuned</strong>: this is the honest first score.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Other measures</h2>
        <dl className="mt-2 divide-y divide-line rounded border border-line bg-surface">
          {rows.map(([k, v, hint]) => (
            <div key={k} className="grid gap-x-4 px-3 py-2 sm:grid-cols-[16rem_9rem_1fr]">
              <dt className="text-sm">{k}</dt>
              <dd className="text-sm font-semibold tabular-nums">{v}</dd>
              {hint && <dd className="text-xs text-muted sm:self-center">{hint}</dd>}
            </div>
          ))}
          <div className="grid gap-x-4 px-3 py-2 sm:grid-cols-[16rem_9rem_1fr]">
            <dt className="text-sm">Judge: replies scored</dt>
            <dd className="text-sm font-semibold tabular-nums">{judgeLine}</dd>
            <dd className="text-xs text-muted sm:self-center">
              An LLM judge from a different model family (Gemini) scores replies 1 to 5 against a
              rubric; 3 or more passes.
            </dd>
          </div>
          <div className="grid gap-x-4 px-3 py-2 sm:grid-cols-[16rem_9rem_1fr]">
            <dt className="text-sm">Judge agreement</dt>
            <dd className="text-sm font-semibold">
              {typeof judgeAgreement === "string" ? "not measured" : "measured"}
            </dd>
            <dd className="text-xs text-muted sm:self-center">
              The check is against 15 replies a person labels by hand, and that has not been done.{" "}
              {aiLine}
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Every case</h2>
        <p className="mb-2 text-sm text-muted">
          {failing.length} of {cases.length} cases fail at least one repeat. Failures, grouped by
          cause, are analysed in docs/failures.md.
        </p>
        <div className="overflow-x-auto rounded border border-line bg-surface">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Case
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Group
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Passed
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Why it failed
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {cases.map((c) => (
                <tr key={c.case_id}>
                  <td className="px-3 py-1.5 font-mono text-xs">{c.case_id}</td>
                  <td className="px-3 py-1.5">{c.category}</td>
                  <td className="px-3 py-1.5 tabular-nums">
                    {c.scored === 0 ? (
                      <span className="text-muted">not scored</span>
                    ) : c.passed === c.scored ? (
                      <span className="text-[var(--ok-fg)]">
                        ✓ {c.passed}/{c.scored}
                      </span>
                    ) : (
                      <span className="text-[var(--bad-fg)]">
                        ✗ {c.passed}/{c.scored}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-muted">
                    {c.reasons.length ? c.reasons.join("; ") : c.incomplete ? c.incomplete : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Big({ label, r }: { label: string; r: Ratio }) {
  const rate = r.of ? (100 * r.n) / r.of : 0;
  return (
    <div className="rounded border border-line bg-surface px-3 py-2">
      <div className="text-xs capitalize text-muted">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{pct(r.n, r.of)}</div>
      <div className="text-xs text-muted tabular-nums">
        {r.n} of {r.of} runs
      </div>
      <div className="mt-1.5 h-1.5 rounded bg-line/60" aria-hidden="true">
        <div className="h-1.5 rounded" style={{ width: `${rate}%`, background: "var(--bar)" }} />
      </div>
    </div>
  );
}
