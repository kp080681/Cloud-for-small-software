BEGIN;

CREATE TABLE app_env_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env_key text NOT NULL,
  source text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  public boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, env_key)
);

CREATE INDEX app_env_requirements_app_idx ON app_env_requirements (app_id);

COMMIT;
