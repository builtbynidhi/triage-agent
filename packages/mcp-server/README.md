# @triage/mcp-server

The agent's toolbox, as a [Model Context Protocol](https://modelcontextprotocol.io) server. The same four tools serve our own agent loop, Claude Desktop, Claude Code, or any other MCP client.

| Tool                | Kind | Input                                | Returns                                                      |
| ------------------- | ---- | ------------------------------------ | ------------------------------------------------------------ |
| `search_policy`     | read | `query`, `top_k` (1 to 8, default 4) | Ranked clauses: `clause_id`, `title`, `text`, `score`        |
| `get_order`         | read | `order_id`                           | Status, dates, items, total, currency, `customer_id`         |
| `get_customer`      | read | `customer_id` **or** `email`         | Name, tier, order count, **masked** email and phone          |
| `check_eligibility` | read | `order_id`, `request_type`           | `eligible`, `reason`, `clause_ids` (rules in code, no model) |

All four are annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. The two approval-gated write tools arrive in Phase 10.

Every failure, bad input included, uses one shape:

```json
{
  "ok": false,
  "code": "not_found",
  "message": "No order with that ID for this tenant.",
  "retryable": false
}
```

Codes: `not_found`, `invalid_input`, `forbidden`, `rate_limited`, `upstream_error`, `needs_approval`. Only `rate_limited` and `upstream_error` are retryable.

The policy documents are also MCP **resources**: `policy://returns`, `policy://refunds`, and so on.

## One server, one merchant

The tenant is fixed when the server starts. It is never a tool argument, so no ticket can steer a tool to another merchant's data. Another merchant's order returns exactly the same `not_found` as a missing one.

| Variable           | Required    | Meaning                                                                                                                        |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `TRIAGE_TENANT`    | yes (stdio) | `tenant_a` (Kaveri Home & Kitchen) or `tenant_b` (Nilgiri Electronics)                                                         |
| `DATABASE_PATH`    | no          | SQLite file. Defaults to `data/triage.db` at the repo root                                                                     |
| `TRIAGE_TODAY`     | no          | Pin "today" (`YYYY-MM-DD`). The seed is anchored to `2026-11-20`, so set this to get the same eligibility answers as the evals |
| `TRIAGE_RETRIEVAL` | no          | `keyword` skips the local models; hybrid is the default                                                                        |

Seed the database and build the policy index first:

```bash
pnpm db:reset && pnpm db:seed && pnpm db:index
```

`db:index` downloads the two local retrieval models once (about 60 MB, into `.cache/models`) and builds the vector index, so the first search is instant. `search_policy` uses hybrid search (keyword plus vector, fused, then reranked by a local cross-encoder). Set `TRIAGE_RETRIEVAL=keyword` to skip the models entirely. See [docs/retrieval.md](../../docs/retrieval.md).

## Use it from Claude Code

```bash
claude mcp add triage-kaveri \
  -e TRIAGE_TENANT=tenant_a -e TRIAGE_TODAY=2026-11-20 \
  -- node /absolute/path/to/triage-agent/packages/mcp-server/src/stdio.ts
```

Then ask, for example: _"Using the triage tools, can order A-10413 still be returned? Cite the policy clause."_

## Use it from Claude Desktop

A live client checks the tools against its own calendar, so the demo uses its own database, seeded relative to the **real** today with no pinned date. (Tests and evals keep the fixed date in `data/triage.db`.)

```bash
pnpm db:demo    # rebuilds data/demo.db as of today in India, builds the index, prints what to ask
```

Re-run it before a demo: order ages move on by a day every day.

Then add this to `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS (`%APPDATA%\Claude\claude_desktop_config.json` on Windows), keeping anything already there, and restart Claude Desktop with ⌘Q:

```json
{
  "mcpServers": {
    "triage-kaveri": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/triage-agent/packages/mcp-server/src/stdio.ts"],
      "env": {
        "TRIAGE_TENANT": "tenant_a",
        "DATABASE_PATH": "/absolute/path/to/triage-agent/data/demo.db"
      }
    },
    "triage-nilgiri": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/triage-agent/packages/mcp-server/src/stdio.ts"],
      "env": {
        "TRIAGE_TENANT": "tenant_b",
        "DATABASE_PATH": "/absolute/path/to/triage-agent/data/demo.db"
      }
    }
  }
}
```

Use absolute paths. Claude Desktop does not use your shell's `PATH`, so give the output of `which node` (Node 22.18 or later). Do not set `TRIAGE_TODAY` here: a pinned date makes the tools contradict the client's calendar, and Claude rightly flags the eligibility answers as wrong.

**Demo script:** A-10413 is always on day 7 of its return window (eligible, `returns.window`), and A-10414 on day 8 (not eligible). B-20410 is `not_found` through triage-kaveri but found through triage-nilgiri: one merchant cannot see another's orders.

## Streamable HTTP

```bash
pnpm mcp:http            # http://127.0.0.1:3100/mcp
```

Send the tenant in an `x-triage-tenant` header. Until Phase 10 adds JWT auth, the HTTP transport binds to localhost only, and rejects foreign `Host` and `Origin` headers.

## Inspect it

```bash
npx @modelcontextprotocol/inspector -e TRIAGE_TENANT=tenant_a node packages/mcp-server/src/stdio.ts
```

## Design notes

- [ADR 0002](../../docs/adr/0002-tools-behind-an-mcp-server.md): why MCP, and why SDK v2.
- [ADR 0003](../../docs/adr/0003-pii-at-the-boundary.md): PII is masked at the tool boundary.
- [ADR 0004](../../docs/adr/0004-eligibility-is-code.md): eligibility is code, not a model.
- [DESIGN.md §2.2](../../DESIGN.md): how the registry, validation and error shape fit together.
