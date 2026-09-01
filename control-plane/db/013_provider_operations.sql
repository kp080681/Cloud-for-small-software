BEGIN;

CREATE TABLE deployment_provider_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  operation_type text NOT NULL,
  provider text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  source_commit_sha text CHECK (source_commit_sha IS NULL OR source_commit_sha ~ '^[0-9a-fA-F]{40}$'),
  provider_project_id text,
  provider_resource_id text,
  status text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, operation_type)
);

CREATE INDEX deployment_provider_operations_deployment_idx
  ON deployment_provider_operations (deployment_id, operation_type);

CREATE INDEX deployment_provider_operations_provider_resource_idx
  ON deployment_provider_operations (provider, provider_resource_id);

COMMIT;
