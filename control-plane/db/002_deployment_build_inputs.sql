BEGIN;

CREATE TABLE deployment_build_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  repository_full_name text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-fA-F]{40}$'),
  git_tree_sha text NOT NULL CHECK (git_tree_sha ~ '^[0-9a-fA-F]{40}$'),
  root_directory text NOT NULL DEFAULT '.',
  package_manager text NOT NULL,
  lockfile text,
  install_command text NOT NULL,
  build_command text NOT NULL,
  start_command text,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deployment_build_inputs_commit_idx
  ON deployment_build_inputs (repository_full_name, commit_sha);

COMMIT;
