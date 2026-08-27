BEGIN;

CREATE TABLE app_runtimes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_project_id text NOT NULL,
  provider_project_name text NOT NULL,
  reconciliation_key text NOT NULL UNIQUE,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX app_runtimes_workspace_idx ON app_runtimes (workspace_id);
CREATE INDEX app_runtimes_provider_project_idx ON app_runtimes (provider, provider_project_id);

COMMIT;
