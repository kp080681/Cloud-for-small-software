BEGIN;

CREATE TABLE deployment_builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_deployment_id text NOT NULL,
  provider_deployment_url text,
  source_commit_sha text NOT NULL CHECK (source_commit_sha ~ '^[0-9a-fA-F]{40}$'),
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_deployment_id)
);

CREATE INDEX deployment_builds_status_idx ON deployment_builds (status);

COMMIT;
