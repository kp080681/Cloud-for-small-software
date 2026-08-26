BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE deployment_status AS ENUM (
  'DRAFT',
  'READY',
  'QUEUED',
  'ANALYZING',
  'PROVISIONING',
  'BUILDING',
  'DEPLOYING',
  'HEALTH_CHECKING',
  'LIVE',
  'FAILED',
  'DELETING',
  'DELETED'
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE github_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  github_installation_id bigint NOT NULL UNIQUE,
  account_login text NOT NULL,
  account_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE github_repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  github_installation_id uuid NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  github_repository_id bigint NOT NULL,
  full_name text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  private boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (github_installation_id, github_repository_id),
  UNIQUE (workspace_id, full_name)
);

CREATE TABLE apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES github_repositories(id),
  name text NOT NULL,
  slug text NOT NULL,
  framework text,
  runtime text,
  root_directory text NOT NULL DEFAULT '.',
  database_required boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE TABLE deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_key text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  source_commit_sha text NOT NULL,
  source_branch text,
  status deployment_status NOT NULL DEFAULT 'DRAFT',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  orchestrator_run_id text,
  runtime_project_id text,
  provider_deployment_id text,
  database_provider_id text,
  live_url text,
  error_code text,
  error_message text,
  queued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deployments_app_created_idx ON deployments (app_id, created_at DESC);
CREATE INDEX deployments_status_idx ON deployments (status);
CREATE INDEX github_repositories_workspace_idx ON github_repositories (workspace_id);

CREATE TABLE deployment_events (
  id bigserial PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  from_status deployment_status,
  to_status deployment_status NOT NULL,
  event_type text NOT NULL DEFAULT 'STATUS_CHANGED',
  message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deployment_events_deployment_idx ON deployment_events (deployment_id, created_at);

CREATE TABLE encrypted_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  encrypted_data_key bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  kms_key_id text NOT NULL,
  encryption_context jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, name)
);

CREATE TABLE app_databases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_project_id text,
  provider_database_id text,
  status text NOT NULL,
  connection_secret_id uuid REFERENCES encrypted_secrets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
