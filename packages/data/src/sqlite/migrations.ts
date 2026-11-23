/** Ordered, append-only migrations. Never edit an applied migration; add a new one. */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const EMBEDDING_DIM = 384; // all-MiniLM-L6-v2 class models; revisit in Phase 4 if the model changes

export const migrations: Migration[] = [
  {
    id: 1,
    name: "core-schema",
    sql: `
CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL
);

CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT NOT NULL,
  tier        TEXT NOT NULL CHECK (tier IN ('standard','plus','vip')),
  UNIQUE (tenant_id, email)
);
CREATE INDEX idx_customers_tenant ON customers(tenant_id);

CREATE TABLE orders (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  status        TEXT NOT NULL CHECK (status IN ('placed','dispatched','delivered','cancelled','returned')),
  placed_at     TEXT NOT NULL,
  dispatched_at TEXT,
  delivered_at  TEXT,
  cancelled_at  TEXT,
  returned_at   TEXT,
  total         INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'INR'
);
CREATE INDEX idx_orders_tenant_customer ON orders(tenant_id, customer_id);
CREATE INDEX idx_orders_tenant_status ON orders(tenant_id, status);

CREATE TABLE order_items (
  id          INTEGER PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  sku         TEXT NOT NULL,
  name        TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  unit_price  INTEGER NOT NULL
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

CREATE TABLE tickets (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  channel     TEXT NOT NULL CHECK (channel IN ('email','chat','web','voice')),
  text        TEXT NOT NULL,
  order_id    TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE runs (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  ticket_id        TEXT NOT NULL REFERENCES tickets(id),
  idempotency_key  TEXT,
  status           TEXT NOT NULL CHECK (status IN ('queued','running','awaiting_approval','done','failed')),
  decision         TEXT CHECK (decision IN ('AUTO_REPLY','NEEDS_INFO','ESCALATE','REJECT')),
  decision_json    TEXT,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0,
  failure_json     TEXT,
  created_at       TEXT NOT NULL,
  finished_at      TEXT
);
CREATE UNIQUE INDEX idx_runs_idempotency ON runs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_runs_tenant_created ON runs(tenant_id, created_at DESC);

CREATE TABLE run_steps (
  id           INTEGER PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('transition','model_call','tool_call','validation')),
  name         TEXT NOT NULL,
  input_json   TEXT,
  output_json  TEXT,
  duration_ms  INTEGER,
  created_at   TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  action        TEXT NOT NULL CHECK (action IN ('create_escalation','send_reply')),
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')) DEFAULT 'pending',
  reviewer      TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
CREATE INDEX idx_approvals_run ON approvals(run_id);
CREATE INDEX idx_approvals_status ON approvals(status);

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  status        TEXT NOT NULL CHECK (status IN ('queued','leased','done','dead')) DEFAULT 'queued',
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  run_after     TEXT NOT NULL,
  lease_until   TEXT,
  last_error    TEXT
);
CREATE INDEX idx_jobs_ready ON jobs(status, run_after);
`,
  },
  {
    id: 2,
    name: "policy-search",
    sql: `
CREATE TABLE policy_chunks (
  clause_id  TEXT PRIMARY KEY,
  doc        TEXT NOT NULL,
  title      TEXT NOT NULL,
  text       TEXT NOT NULL
);

-- Keyword index. Standalone (not external-content) so it can be rebuilt by simple re-insert.
CREATE VIRTUAL TABLE policy_fts USING fts5(
  clause_id UNINDEXED, title, text, tokenize = 'porter unicode61'
);

-- Vector index. rowid matches policy_chunks.rowid. Filled by the retrieval phase.
CREATE VIRTUAL TABLE policy_vec USING vec0(embedding float[${EMBEDDING_DIM}]);
`,
  },
  {
    id: 3,
    name: "tenant-scoped-retrieval",
    sql: `
-- Retrieval is scoped per tenant (OWASP LLM09). NULL = a shared policy every tenant sees;
-- a tenant ID = a policy only that tenant's searches can return.
ALTER TABLE policy_chunks ADD COLUMN tenant_id TEXT REFERENCES tenants(id);
CREATE INDEX idx_policy_chunks_tenant ON policy_chunks(tenant_id);

-- What each vector in policy_vec was built from, so the index re-embeds exactly the
-- chunks whose text, position or embedding model changed, and nothing else.
CREATE TABLE policy_vec_meta (
  clause_id    TEXT PRIMARY KEY,
  chunk_rowid  INTEGER NOT NULL,
  model        TEXT NOT NULL,
  text_hash    TEXT NOT NULL
);
`,
  },
  {
    id: 4,
    name: "approvals-and-outbox",
    sql: `
-- One proposal per run and action: a retried worker cannot file a second approval.
CREATE UNIQUE INDEX idx_approvals_run_action ON approvals(run_id, action);

-- The record of a write that actually happened. One row per approval (UNIQUE), so approving the
-- same proposal twice cannot send the same reply twice. Nothing leaves the system except through here.
CREATE TABLE outbox (
  id           TEXT PRIMARY KEY,
  approval_id  TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  run_id       TEXT NOT NULL REFERENCES runs(id),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  action       TEXT NOT NULL CHECK (action IN ('create_escalation','send_reply')),
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_outbox_tenant ON outbox(tenant_id, created_at DESC);
`,
  },
  {
    id: 5,
    name: "run-traces",
    sql: `
-- The span tree of a run (OpenTelemetry GenAI spans as JSON), saved with the run so the web app
-- can draw it without reading trace files back. One row per run.
CREATE TABLE run_spans (
  run_id      TEXT PRIMARY KEY REFERENCES runs(id),
  spans_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
`,
  },
];
