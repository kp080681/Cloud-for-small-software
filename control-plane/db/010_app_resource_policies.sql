BEGIN;

CREATE TABLE app_resource_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
  policy_tier text NOT NULL DEFAULT 'starter',
  max_build_minutes integer NOT NULL DEFAULT 15 CHECK (max_build_minutes BETWEEN 1 AND 60),
  max_env_vars integer NOT NULL DEFAULT 50 CHECK (max_env_vars BETWEEN 1 AND 200),
  max_log_events integer NOT NULL DEFAULT 200 CHECK (max_log_events BETWEEN 10 AND 2000),
  max_health_attempts integer NOT NULL DEFAULT 3 CHECK (max_health_attempts BETWEEN 1 AND 10),
  max_deployments_per_day integer NOT NULL DEFAULT 20 CHECK (max_deployments_per_day BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (policy_tier IN ('free','starter','builder','team','business'))
);

CREATE INDEX app_resource_policies_workspace_idx
  ON app_resource_policies (workspace_id);

COMMIT;
