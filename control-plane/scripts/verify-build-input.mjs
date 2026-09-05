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
            d.source_commit_sha,
            b.repository_full_name,
            b.commit_sha,
            b.git_tree_sha,
            b.root_directory,
            b.package_manager,
            b.lockfile,
            b.install_command,
            b.build_command,
            b.start_command,
            b.manifest_sha256,
            b.created_at
       FROM deployments d
       JOIN apps a ON a.id = d.app_id
       LEFT JOIN deployment_build_inputs b ON b.deployment_id = d.id
      WHERE d.id = $1`,
    [deployment.id],
  );

  const row = result.rows[0];

  console.log(JSON.stringify({
    result: row.manifest_sha256 ? "NODE_04_7_BUILD_INPUT_VERIFIED" : "NODE_04_7_BUILD_INPUT_NOT_READY",
    appSlug: deployment.app_slug,
    deploymentId: row.deployment_id,
    deploymentKey: row.deployment_key,
    status: row.status,
    sourceCommitSha: row.source_commit_sha,
    buildInput: row.manifest_sha256 ? {
      repository: row.repository_full_name,
      commitSha: row.commit_sha,
      gitTreeSha: row.git_tree_sha,
      rootDirectory: row.root_directory,
      packageManager: row.package_manager,
      lockfile: row.lockfile,
      installCommand: row.install_command,
      buildCommand: row.build_command,
      startCommand: row.start_command,
      manifestSha256: row.manifest_sha256,
      createdAt: row.created_at,
      sourceIdentityMatches: row.commit_sha === row.source_commit_sha,
    } : null,
  }, null, 2));
} finally {
  await db.end();
}
