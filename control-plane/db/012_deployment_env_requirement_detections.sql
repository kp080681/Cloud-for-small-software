BEGIN;

CREATE TABLE deployment_env_detection_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  repository_full_name text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-fA-F]{40}$'),
  git_tree_sha text NOT NULL CHECK (git_tree_sha ~ '^[0-9a-fA-F]{40}$'),
  root_directory text NOT NULL,
  detector_version text NOT NULL,
  detected_count integer NOT NULL CHECK (detected_count >= 0),
  scanned_file_count integer NOT NULL CHECK (scanned_file_count >= 0),
  skipped_file_count integer NOT NULL CHECK (skipped_file_count >= 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deployment_env_requirement_detections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES deployment_env_detection_snapshots(id) ON DELETE CASCADE,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env_key text NOT NULL,
  reference_kind text NOT NULL,
  required_inference text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  sources jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, env_key),
  CHECK (reference_kind IN ('process-env-static')),
  CHECK (required_inference IN ('reference-observed'))
);

CREATE INDEX deployment_env_requirement_detections_app_idx
  ON deployment_env_requirement_detections (app_id, env_key);

COMMIT;
