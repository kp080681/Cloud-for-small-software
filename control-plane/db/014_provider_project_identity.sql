BEGIN;

CREATE UNIQUE INDEX app_runtimes_provider_project_unique_idx
  ON app_runtimes (provider, provider_project_id)
  WHERE provider_project_id IS NOT NULL;

COMMIT;
