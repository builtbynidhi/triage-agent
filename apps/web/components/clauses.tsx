import type { StepView } from "@/lib/types";

interface Hit {
  clause_id: string;
  title?: string;
  text?: string;
  score?: number;
}

/**
 * The policy clauses each search returned, with the reranker's score, and which of them the final
 * reply actually cited. A clause the agent never read cannot be cited (the validator refuses it).
 */
export function RetrievedClauses({ steps, cited }: { steps: StepView[]; cited: string[] }) {
  const searches = steps.filter((s) => s.kind === "tool_call" && s.name === "search_policy");
  if (!searches.length)
    return <p className="text-sm text-muted">The agent searched no policy for this ticket.</p>;
  const retrieved = new Set(
    searches.flatMap((s) =>
      ((s.output as { results?: Hit[] } | undefined)?.results ?? []).map((h) => h.clause_id),
    ),
  );
  const unread = cited.filter((c) => !retrieved.has(c));
  return (
    <div className="space-y-4">
      {unread.length > 0 && (
        <p className="rounded border border-[var(--info-fg)] bg-[var(--info-bg)] px-3 py-2 text-sm text-[var(--info-fg)]">
          <strong>Cited without being retrieved:</strong> {unread.join(", ")}. The ID reached the
          reply through <code>check_eligibility</code>, which returns clause IDs without their text,
          so the model cited a clause whose wording it never read. This is the failure the Phase 8
          analysis found in most runs.
        </p>
      )}
      {searches.map((s) => {
        const hits = ((s.output as { results?: Hit[] } | undefined)?.results ?? []).filter(
          (h) => h.clause_id,
        );
        const scores = hits.map((h) => h.score ?? 0);
        const hi = Math.max(...scores, 0);
        const lo = Math.min(...scores, 0);
        const query = (s.input as { query?: string } | undefined)?.query;
        return (
          <div key={s.seq}>
            <p className="mb-2 text-sm text-muted">
              Search:{" "}
              <span className="font-mono text-fg">&ldquo;{query ?? "(no query)"}&rdquo;</span>
            </p>
            <ol className="space-y-2">
              {hits.map((h, i) => {
                const width =
                  hi === lo ? 100 : Math.max(4, (100 * ((h.score ?? 0) - lo)) / (hi - lo));
                const used = cited.includes(h.clause_id);
                return (
                  <li key={h.clause_id} className="rounded border border-line bg-surface px-3 py-2">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-xs text-muted">#{i + 1}</span>
                      <span className="font-mono text-sm font-semibold">{h.clause_id}</span>
                      {used && (
                        <span className="rounded bg-[var(--ok-bg)] px-1.5 text-xs font-semibold text-[var(--ok-fg)]">
                          ✓ cited in the reply
                        </span>
                      )}
                      <span className="ml-auto font-mono text-xs text-muted">
                        score {(h.score ?? 0).toFixed(2)}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 rounded bg-line/60" aria-hidden="true">
                      <div
                        className="h-1.5 rounded"
                        style={{ width: `${width}%`, background: "var(--bar)" }}
                      />
                    </div>
                    {h.title && <p className="mt-1.5 text-sm font-medium">{h.title}</p>}
                    {h.text && <p className="mt-0.5 text-sm text-muted">{h.text}</p>}
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
    </div>
  );
}
