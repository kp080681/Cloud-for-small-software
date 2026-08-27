BEGIN;

CREATE TABLE deployment_logs (
  id bigserial PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  source text NOT NULL,
  provider text,
  provider_deployment_id text,
  severity text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  provider_timestamp timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deployment_logs_deployment_idx
  ON deployment_logs (deployment_id, created_at DESC);

CREATE INDEX deployment_logs_provider_idx
  ON deployment_logs (provider, provider_deployment_id);

COMMIT;
