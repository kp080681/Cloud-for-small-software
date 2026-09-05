import pg from "pg";
import {
  optionalAppId,
  optionalDeploymentId,
  requireAppSlug,
  requireWorkspaceId,
  resolveDeploymentTarget,
  resolveLatestDeploymentForAppTarget,
} from "../src/operator-targeting.mjs";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");

const deploymentId = optionalDeploymentId();
const workspaceId = deploymentId ? process.env.CONTROL_PLANE_WORKSPACE_ID?.trim?.() : requireWorkspaceId();
const appId = process.env.CONTROL_PLANE_APP_ID ? optionalAppId() : null;
const appSlug = deploymentId || appId ? process.env.CONTROL_PLANE_APP_SLUG?.trim?.() || null : requireAppSlug();
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  const deployment = deploymentId
    ? await resolveDeploymentTarget(db, { deploymentId, workspaceId, appId, slug: appSlug })
    : await resolveLatestDeploymentForAppTarget(db, { workspaceId, appId, slug: appSlug });
  const result = await db.query(
    `SELECT d.id AS deployment_id,
            d.deployment_key,
            d.status,
            d.runtime_project_id,
            a.slug,
            r.provider,
            r.provider_project_id,
            r.provider_project_name,
            r.reconciliation_key,
            r.status AS runtime_status,
            r.created_at,
            r.updated_at
       FROM deployments d
       JOIN apps a ON a.id = d.app_id
       LEFT JOIN app_runtimes r ON r.app_id = a.id
      WHERE d.id = $1`,
    [deployment.id],
  );

  const row = result.rows[0];
  const ready = Boolean(row.provider_project_id) && row.runtime_project_id === row.provider_project_id;

  console.log(JSON.stringify({
    result: ready ? "NODE_04_8_RUNTIME_VERIFIED" : "NODE_04_8_RUNTIME_NOT_READY",
    appSlug: deployment.app_slug,
    deploymentId: row.deployment_id,
    deploymentKey: row.deployment_key,
    deploymentStatus: row.status,
    runtimeProjectId: row.runtime_project_id,
    runtime: row.provider_project_id ? {
      provider: row.provider,
      providerProjectId: row.provider_project_id,
      providerProjectName: row.provider_project_name,
      reconciliationKey: row.reconciliation_key,
      status: row.runtime_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deploymentBindingMatches: row.runtime_project_id === row.provider_project_id,
    } : null,
  }, null, 2));
} finally {
  await db.end();
}
