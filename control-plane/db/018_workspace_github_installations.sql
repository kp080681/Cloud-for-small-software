BEGIN;

CREATE TABLE workspace_github_installations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  github_installation_id uuid NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  connected_by_customer_identity_id uuid REFERENCES customer_identities(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, github_installation_id)
);

INSERT INTO workspace_github_installations (workspace_id, github_installation_id)
SELECT workspace_id, id
FROM github_installations
ON CONFLICT (workspace_id, github_installation_id) DO NOTHING;

ALTER TABLE github_repositories
  DROP CONSTRAINT IF EXISTS github_repositories_github_installation_id_github_repository_id_key;

CREATE UNIQUE INDEX github_repositories_workspace_installation_repo_idx
  ON github_repositories (workspace_id, github_installation_id, github_repository_id);

COMMIT;
