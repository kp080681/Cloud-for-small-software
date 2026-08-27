BEGIN;

CREATE TABLE deployment_health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  check_url text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL,
  http_status integer,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, attempt_number)
);

CREATE INDEX deployment_health_checks_deployment_idx
  ON deployment_health_checks (deployment_id, checked_at DESC);

COMMIT;
