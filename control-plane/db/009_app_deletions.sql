BEGIN;

CREATE TABLE app_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
  deletion_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'REQUESTED',
  provider text,
  provider_project_id text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  provider_deleted_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('REQUESTED','DELETING','PROVIDER_DELETED','COMPLETED','FAILED'))
);

CREATE INDEX app_deletions_status_idx ON app_deletions (status, requested_at);

COMMIT;
