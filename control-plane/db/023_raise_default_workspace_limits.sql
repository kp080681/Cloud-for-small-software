BEGIN;

-- The engine's default workspace limits were raised from 3 to 25 apps and
-- deployments, but the dashboard kept seeding new workspaces at 3/3 (and the
-- column defaults stayed at 3). Any workspace whose policy row was created
-- by the dashboard is therefore still capped at 3 apps.
--
-- Raise only rows that still hold the old untouched default (3), so any
-- limit deliberately set to something else is left alone.
UPDATE workspace_resource_policies
   SET max_active_apps = 25, updated_at = now()
 WHERE max_active_apps = 3;

UPDATE workspace_resource_policies
   SET max_active_deployments = 25, updated_at = now()
 WHERE max_active_deployments = 3;

ALTER TABLE workspace_resource_policies
  ALTER COLUMN max_active_apps SET DEFAULT 25,
  ALTER COLUMN max_active_deployments SET DEFAULT 25;

COMMIT;
