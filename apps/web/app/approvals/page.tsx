import Link from "next/link";
import { DecisionBadge } from "@/components/badge";
import { JsonBlock } from "@/components/json-block";
import { approvalsEnabled, getMode, listApprovals } from "@/lib/data";
import { excerpt } from "@/lib/format";
import { decide } from "../actions";

export const metadata = { title: "Approvals" };
export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const items = await listApprovals("pending");
  const canDecide = approvalsEnabled();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Approval queue</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          The agent only <em>proposes</em>. Nothing is sent or escalated until a reviewer approves
          exactly what is shown here: the approval is bound to this reply text, not a blank cheque.
        </p>
        {!canDecide && (
          <p className="mt-2 max-w-3xl rounded border border-line bg-surface px-3 py-2 text-sm">
            {getMode() === "snapshot"
              ? "This is the public, read-only demo, so these proposals are shown but cannot be approved here."
              : "Approving from this page is switched off (set TRIAGE_WEB_ALLOW_APPROVE=true on a machine you trust). Reviewers approve through the API."}
          </p>
        )}
      </div>

      <p className="text-sm text-muted">
        {items.length} pending proposal{items.length === 1 ? "" : "s"}
      </p>

      <ul className="space-y-3">
        {items.map((a) => (
          <li key={a.id} className="rounded border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <DecisionBadge decision={a.run?.decision ?? null} />
              <span className="font-mono text-sm font-semibold">{a.action}</span>
              {a.run && (
                <Link href={`/runs/${a.run_id}`} className="min-w-0 flex-1 truncate text-sm">
                  {excerpt(a.run.ticket.text, 90)}
                </Link>
              )}
            </div>

            {a.action === "send_reply" ? (
              <blockquote className="mt-3 whitespace-pre-wrap border-l-4 border-line pl-3 text-sm">
                {String(a.payload.body ?? "")}
                <footer className="mt-1 text-xs text-muted">
                  cites{" "}
                  {((a.payload.clause_ids as string[] | undefined) ?? []).join(", ") || "no clause"}
                </footer>
              </blockquote>
            ) : (
              <div className="mt-3 space-y-1 text-sm">
                <p>
                  <span className="font-semibold">Reason:</span> {String(a.payload.reason ?? "")}
                </p>
                <p className="text-muted">{String(a.payload.summary ?? "")}</p>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <form action={decide}>
                <input type="hidden" name="id" value={a.id} />
                <input type="hidden" name="verb" value="approve" />
                <button
                  type="submit"
                  disabled={!canDecide}
                  className="rounded border border-[var(--ok-fg)] px-3 py-1 text-sm font-semibold text-[var(--ok-fg)] hover:bg-[var(--ok-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Approve
                </button>
              </form>
              <form action={decide}>
                <input type="hidden" name="id" value={a.id} />
                <input type="hidden" name="verb" value="reject" />
                <button
                  type="submit"
                  disabled={!canDecide}
                  className="rounded border border-line px-3 py-1 text-sm hover:bg-line/40 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Reject
                </button>
              </form>
              <span className="ml-auto font-mono text-xs text-muted">{a.id}</span>
            </div>
            <div className="mt-3">
              <JsonBlock label="Full proposed payload" value={a.payload} />
            </div>
          </li>
        ))}
      </ul>

      {items.length === 0 && <p className="text-muted">Nothing is waiting for approval.</p>}
    </div>
  );
}
