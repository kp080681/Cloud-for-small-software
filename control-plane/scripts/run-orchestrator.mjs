import { tasks } from "@trigger.dev/sdk";
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
if (!process.env.TRIGGER_SECRET_KEY) throw new Error("Missing required environment variable: TRIGGER_SECRET_KEY");

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
  const handle = await tasks.trigger("ssc-control-plane-orchestrate-deployment", { deploymentId: deployment.id });
  console.log(JSON.stringify({
    result: "NODE_04_15_E2E_TRIGGERED",
    appSlug: deployment.app_slug,
    deploymentId: deployment.id,
    deploymentKey: deployment.deployment_key,
    statusBeforeRun: deployment.status,
    commitSha: deployment.source_commit_sha,
    triggerRunId: handle.id,
  }, null, 2));
} finally {
  await db.end();
}
