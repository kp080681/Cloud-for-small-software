BEGIN;

CREATE TABLE workspace_resource_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  max_active_apps integer NOT NULL DEFAULT 3 CHECK (max_active_apps BETWEEN 0 AND 50),
  max_active_deployments integer NOT NULL DEFAULT 3 CHECK (max_active_deployments BETWEEN 0 AND 100),
  max_active_deployments_per_app integer NOT NULL DEFAULT 1 CHECK (max_active_deployments_per_app BETWEEN 0 AND 20),
  max_concurrent_provider_operations integer NOT NULL DEFAULT 2 CHECK (max_concurrent_provider_operations BETWEEN 0 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_resource_policies_workspace_idx
  ON workspace_resource_policies (workspace_id);

COMMIT;
