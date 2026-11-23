# Deploying the public demo to Vercel

The public demo is the web app in **snapshot mode**: a read-only copy of 38 real runs, with their traces, tool calls, retrieved clauses and decisions. It needs no database, no API and no secrets, so it deploys to Vercel's free Hobby plan. (Vercel cannot load the SQLite native code the live system uses, which is why the demo reads a JSON snapshot. See DESIGN.md 2.9.)

## One-time setup (about two minutes, you do this part)

1. Sign in at [vercel.com](https://vercel.com) with GitHub. Use the **Hobby** plan. If anything asks for a card, stop: nothing here needs one.
2. **Add New → Project** and import `builtbynidhi/triage-agent`.
3. Under **Root Directory**, choose `apps/web`. Leave the framework as Next.js (detected) and **leave environment variables empty**. `apps/web/vercel.json` already sets the install command, so only the web app's packages are installed.
4. **Deploy.** Open the link: the run list shows 38 runs, and each run opens to its span tree.

Every push to `main` redeploys it.

## Refreshing the data

```bash
pnpm web:snapshot        # replays the recorded tickets through the real worker: 0 API calls, $0
git add apps/web/data/snapshot.json && git commit -m "chore(web): refresh the demo snapshot" && git push
```

## What the public link is, and is not

- **Is:** real runs of the real agent (hybrid retrieval, tools, OpenTelemetry spans), with the model replayed from its committed recording. Nothing is invented; latencies are the recorded provider latencies.
- **Is not:** a live agent. Nobody can submit a ticket, and the Approve and Reject buttons are disabled. The "live view" replays the recorded steps and says so.
- **Holds no secret and no customer data:** the tickets are synthetic eval cases, the snapshot has no prompts or tool content, and a test (`apps/web/lib/snapshot.test.ts`) fails if a key-shaped string or message content ever appears in it.

## Done when

The deployed link shows the run list with at least 20 runs and a populated trace viewer (spec, Phase 11). That cannot be checked from the repository: it needs the steps above.
