BEGIN;

-- Fixed-window per-workspace rate limiting. One row per (workspace, action,
-- window). `window_start` is the start of the current fixed window, computed
-- in application code (see rate-limit.mjs) rather than in SQL, so the bucket
-- boundary logic lives in one testable place. The atomic upsert in the
-- application layer (INSERT ... ON CONFLICT DO UPDATE SET count = count + 1)
-- is what makes this safe under concurrent requests, the same pattern already
-- proven for provider-operation claiming in provider-mutation-fencing.mjs.
CREATE TABLE workspace_rate_limit_counters (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, action, window_start)
);

-- Supports periodic cleanup of old windows without a full table scan.
CREATE INDEX workspace_rate_limit_counters_window_idx ON workspace_rate_limit_counters (window_start);

COMMIT;
