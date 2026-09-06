import pg from "pg";
import {
  DEFAULT_WORKSPACE_RESOURCE_POLICY,
  validateWorkspaceResourcePolicy,
} from "../src/workspace-resource-policy.mjs";

const { Client } = pg;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalIntegerEnv(name, fallback) {
  const value = process.env[name]?.trim();
  if (value == null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");
const workspaceId = requireEnv("CONTROL_PLANE_WORKSPACE_ID");

const policy = validateWorkspaceResourcePolicy({
  maxActiveApps: optionalIntegerEnv("CONTROL_PLANE_MAX_ACTIVE_APPS", DEFAULT_WORKSPACE_RESOURCE_POLICY.maxActiveApps),
  maxActiveDeployments: optionalIntegerEnv("CONTROL_PLANE_MAX_ACTIVE_DEPLOYMENTS", DEFAULT_WORKSPACE_RESOURCE_POLICY.maxActiveDeployments),
  maxActiveDeploymentsPerApp: optionalIntegerEnv("CONTROL_PLANE_MAX_ACTIVE_DEPLOYMENTS_PER_APP", DEFAULT_WORKSPACE_RESOURCE_POLICY.maxActiveDeploymentsPerApp),
  maxConcurrentProviderOperations: optionalIntegerEnv("CONTROL_PLANE_MAX_CONCURRENT_PROVIDER_OPERATIONS", DEFAULT_WORKSPACE_RESOURCE_POLICY.maxConcurrentProviderOperations),
});

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  await db.query("BEGIN");
  const workspace = await db.query(
    `SELECT id, name FROM workspaces WHERE id=$1 FOR UPDATE`,
    [workspaceId],
  );
  if (workspace.rowCount !== 1) throw new Error(`Workspace not found: ${workspaceId}`);

  const result = await db.query(
    `INSERT INTO workspace_resource_policies
       (workspace_id, max_active_apps, max_active_deployments, max_active_deployments_per_app, max_concurrent_provider_operations)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workspace_id) DO UPDATE SET
       max_active_apps = EXCLUDED.max_active_apps,
       max_active_deployments = EXCLUDED.max_active_deployments,
       max_active_deployments_per_app = EXCLUDED.max_active_deployments_per_app,
       max_concurrent_provider_operations = EXCLUDED.max_concurrent_provider_operations,
       updated_at = now()
     RETURNING workspace_id, max_active_apps, max_active_deployments, max_active_deployments_per_app, max_concurrent_provider_operations, updated_at`,
    [
      workspaceId,
      policy.maxActiveApps,
      policy.maxActiveDeployments,
      policy.maxActiveDeploymentsPerApp,
      policy.maxConcurrentProviderOperations,
    ],
  );
  await db.query("COMMIT");

  const updated = result.rows[0];
  console.log(JSON.stringify({
    result: "WORKSPACE_RESOURCE_POLICY_UPDATED",
    workspaceId: updated.workspace_id,
    workspaceName: workspace.rows[0].name,
    policy: {
      maxActiveApps: updated.max_active_apps,
      maxActiveDeployments: updated.max_active_deployments,
      maxActiveDeploymentsPerApp: updated.max_active_deployments_per_app,
      maxConcurrentProviderOperations: updated.max_concurrent_provider_operations,
    },
    updatedAt: updated.updated_at,
    secretsPrinted: false,
  }, null, 2));
} catch (error) {
  await db.query("ROLLBACK");
  throw error;
} finally {
  await db.end();
}
