BEGIN;

ALTER TABLE apps
  ADD COLUMN database_mode text NOT NULL DEFAULT 'NONE';

ALTER TABLE apps
  ADD CONSTRAINT apps_database_mode_check
  CHECK (database_mode IN ('NONE', 'EXTERNAL', 'SSC_MANAGED'));

UPDATE apps
   SET database_mode = CASE
     WHEN database_required THEN 'EXTERNAL'
     ELSE 'NONE'
   END;

ALTER TABLE app_databases
  ADD COLUMN database_mode text,
  ADD COLUMN provider_project_name text,
  ADD COLUMN provider_branch_id text,
  ADD COLUMN provider_endpoint_id text,
  ADD COLUMN provider_database_name text,
  ADD COLUMN provider_role_name text,
  ADD COLUMN reconciliation_key text,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN delete_error_code text,
  ADD COLUMN delete_error_message text,
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE app_databases
   SET database_mode = 'EXTERNAL'
 WHERE database_mode IS NULL;

ALTER TABLE app_databases
  ALTER COLUMN database_mode SET DEFAULT 'SSC_MANAGED',
  ALTER COLUMN database_mode SET NOT NULL;

ALTER TABLE app_databases
  ADD CONSTRAINT app_databases_mode_check
  CHECK (database_mode IN ('EXTERNAL', 'SSC_MANAGED'));

CREATE UNIQUE INDEX app_databases_reconciliation_key_idx
  ON app_databases (reconciliation_key)
  WHERE reconciliation_key IS NOT NULL;

CREATE UNIQUE INDEX app_databases_provider_project_idx
  ON app_databases (provider, provider_project_id)
  WHERE provider_project_id IS NOT NULL;

ALTER TABLE workspace_resource_policies
  ADD COLUMN max_managed_databases integer NOT NULL DEFAULT 3
  CHECK (max_managed_databases BETWEEN 0 AND 50);

COMMIT;
