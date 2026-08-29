BEGIN;

ALTER TABLE deployments
  ADD COLUMN parent_deployment_id uuid REFERENCES deployments(id) ON DELETE SET NULL,
  ADD COLUMN deployment_reason text NOT NULL DEFAULT 'initial';

ALTER TABLE deployments
  ADD CONSTRAINT deployments_reason_check
  CHECK (deployment_reason IN ('initial','redeploy','rollback','manual'));

CREATE INDEX deployments_parent_idx
  ON deployments (parent_deployment_id);

COMMIT;
