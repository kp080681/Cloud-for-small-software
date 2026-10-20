BEGIN;

-- Push-to-deploy (2026-10-20): a verified GitHub push to an app's main
-- branch redeploys it automatically. On by default for every app, per
-- Kiran; each app can be switched off.

ALTER TABLE apps
  ADD COLUMN auto_deploy_on_push boolean NOT NULL DEFAULT true;

-- Deployments started by a push are recorded as such, so history shows
-- why each deployment exists.
ALTER TABLE deployments
  DROP CONSTRAINT deployments_reason_check;
ALTER TABLE deployments
  ADD CONSTRAINT deployments_reason_check
  CHECK (deployment_reason IN ('initial','redeploy','rollback','manual','push'));

-- Every webhook delivery GitHub sends, keyed by GitHub's own delivery id.
-- GitHub retries deliveries; the UNIQUE constraint is what guarantees a
-- retried delivery can never start a second deployment.
CREATE TABLE github_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  github_installation_id bigint,
  github_repository_id bigint,
  ref text,
  after_sha text,
  status text NOT NULL DEFAULT 'received',
  detail text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX github_webhook_deliveries_repo_idx
  ON github_webhook_deliveries (github_repository_id, received_at DESC);

COMMIT;
