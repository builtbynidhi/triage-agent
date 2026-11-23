# The public demo

**Live: <https://triage-agent-demo-tau.vercel.app>**

The public demo is the web app in **snapshot mode**: a read-only copy of 38 real runs, with their traces, tool calls, retrieved clauses and decisions. It needs no database, no API and no secrets, so it runs on Vercel's free Hobby plan. (Vercel cannot load the SQLite native code the live system uses, which is why the demo reads a JSON snapshot. See DESIGN.md 2.9.)

## What the public link is, and is not

- **Is:** real runs of the real agent (hybrid retrieval, tools, OpenTelemetry spans), with the model replayed from its committed recording. Nothing is invented; latencies are the recorded provider latencies.
- **Is not:** a live agent. Nobody can submit a ticket, and the Approve and Reject buttons are disabled. The "live view" replays the recorded steps and says so.
- **Holds no secret and no customer data:** the tickets are synthetic eval cases, the snapshot has no prompts or tool content, and a test (`apps/web/lib/snapshot.test.ts`) fails if a key-shaped string or message content ever appears in it.

## Redeploying (after refreshing the snapshot, or changing the UI)

```bash
pnpm web:snapshot                 # replays the recorded tickets through the real worker: 0 API calls, $0
git add apps/web/data/snapshot.json && git commit -m "chore(web): refresh the demo snapshot" && git push
bash scripts/deploy-demo.sh       # builds a standalone folder, checks it builds alone, deploys to production
```

One-time, in a terminal: `npx vercel@latest login` (it opens your browser; use the free Hobby plan, and stop if anything asks for a card). The script builds a small standalone folder of the web app with the exact tested package versions, so nothing else from the repository is uploaded: no `.env`, no recordings, no database. The Vercel project is `triage-agent-demo`; the script links to it by name.

## Alternative: import the GitHub repository

This deploys on every push to `main`, but needs you to authorize Vercel's GitHub app, which only you can do. In Vercel: Add New → Project → import `builtbynidhi/triage-agent`, set **Root Directory** to `apps/web`, leave environment variables empty. `apps/web/vercel.json` already limits the install to the web app's packages (checked in a fresh clone: 42 pages build without SQLite, ONNX or Express).

## Checked

Fetched anonymously (no login wall; the project's production URL is public): the run list shows 38 runs, a run page shows its span tree, tool calls, retrieved clauses, validation and decision, an unknown run is a 404, the live-stream route refuses in demo mode, and the security headers are set (`nosniff`, frame-deny, strict referrer policy). A headless-Chrome screenshot of the deployed site matches the local build.
