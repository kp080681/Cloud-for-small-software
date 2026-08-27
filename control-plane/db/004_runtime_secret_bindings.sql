BEGIN;

CREATE TABLE app_secret_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env_key text NOT NULL,
  secret_id uuid NOT NULL REFERENCES encrypted_secrets(id) ON DELETE CASCADE,
  target_environment text NOT NULL DEFAULT 'production',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, env_key, target_environment)
);

CREATE TABLE deployment_secret_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES app_secret_bindings(id) ON DELETE CASCADE,
  secret_updated_at timestamptz NOT NULL,
  provider_env_id text,
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, binding_id)
);

CREATE INDEX app_secret_bindings_app_idx ON app_secret_bindings (app_id);
CREATE INDEX deployment_secret_applications_deployment_idx ON deployment_secret_applications (deployment_id);

COMMIT;
