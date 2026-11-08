-- Design fixture only. NOT a production migration. Tested against local SQLite.
-- Use a separate benchmark D1 database/binding. Do not run against Social DB.
PRAGMA foreign_keys = ON;

CREATE TABLE benchmark_contributors (
  id TEXT PRIMARY KEY,
  credential_sha256 TEXT NOT NULL UNIQUE,
  consent_version TEXT NOT NULL,
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Contains allowlisted canonical context only, never a raw configuration dump.
CREATE TABLE benchmark_contexts (
  sha256 TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  context_json TEXT NOT NULL CHECK (json_valid(context_json))
);

CREATE TABLE benchmark_runs (
  contributor_id TEXT NOT NULL REFERENCES benchmark_contributors(id) ON DELETE CASCADE,
  client_run_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  context_sha256 TEXT NOT NULL REFERENCES benchmark_contexts(sha256),
  recorded_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'cancelled')),
  payload_sha256 TEXT NOT NULL,
  source_sha256 TEXT,
  PRIMARY KEY (contributor_id, client_run_id)
);
CREATE INDEX benchmark_runs_context_date ON benchmark_runs(context_sha256, recorded_at);
CREATE INDEX benchmark_runs_owner_date ON benchmark_runs(contributor_id, recorded_at);

CREATE TABLE benchmark_windows (
  contributor_id TEXT NOT NULL,
  client_run_id TEXT NOT NULL,
  pass_index INTEGER NOT NULL CHECK (pass_index > 0),
  metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
  PRIMARY KEY (contributor_id, client_run_id, pass_index),
  FOREIGN KEY (contributor_id, client_run_id)
    REFERENCES benchmark_runs(contributor_id, client_run_id) ON DELETE CASCADE
);

-- Append assessments. Snapshot builders select one explicit latest revision.
-- Client requests may not set any of these fields.
CREATE TABLE benchmark_assessments (
  contributor_id TEXT NOT NULL,
  client_run_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  policy_version TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisional', 'accepted', 'rejected')),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json)),
  PRIMARY KEY (contributor_id, client_run_id, revision),
  FOREIGN KEY (contributor_id, client_run_id)
    REFERENCES benchmark_runs(contributor_id, client_run_id) ON DELETE CASCADE
);

-- Derived cache, never the evidence source. Withdrawal invalidates affected
-- generations before they can be served, then rebuilds from retained rows.
CREATE TABLE benchmark_snapshots (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  aggregation_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  CHECK (period_end > period_start)
);
