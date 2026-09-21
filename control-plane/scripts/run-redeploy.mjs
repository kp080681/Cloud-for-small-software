import pg from "pg";
import { tasks } from "@trigger.dev/sdk";
import { optionalAppId, requireAppSlug, requireWorkspaceId, resolveAppTarget } from "../src/operator-targeting.mjs";

for (const name of ["DATABASE_URL", "TRIGGER_SECRET_KEY"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const workspaceId = requireWorkspaceId();
const appId = optionalAppId();
const appSlug = appId ? null : requireAppSlug();
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let app;
try {
  app = await resolveAppTarget(db, { workspaceId, appId, slug: appSlug });
} finally {
  await db.end();
}

const createHandle = await tasks.trigger("ssc-control-plane-create-redeployment", { appId: app.id, workspaceId });
console.log(JSON.stringify({
  result: "NODE_04_16_REDEPLOY_REQUESTED",
  appId: app.id,
  appName: app.name,
  appSlug: app.slug,
  createRedeploymentRunId: createHandle.id,
  next: "Open this Trigger run. Its output contains the new deploymentId. Then run the orchestrator for that deploymentId.",
}, null, 2));
