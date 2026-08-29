import pg from "pg";
import { tasks } from "@trigger.dev/sdk";

for (const name of ["DATABASE_URL", "TRIGGER_SECRET_KEY"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const appSlug = (process.env.CONTROL_PLANE_APP_SLUG || "vantage").toLowerCase();
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

let app;
try {
  const result = await db.query(
    `SELECT id, name, slug FROM apps WHERE lower(slug)=lower($1) AND deleted_at IS NULL LIMIT 1`,
    [appSlug],
  );
  if (result.rowCount === 0) throw new Error(`Active app not found for slug: ${appSlug}`);
  app = result.rows[0];
} finally {
  await db.end();
}

const createHandle = await tasks.trigger("ssc-control-plane-create-redeployment", { appId: app.id });
console.log(JSON.stringify({
  result: "NODE_04_16_REDEPLOY_REQUESTED",
  appId: app.id,
  appName: app.name,
  appSlug: app.slug,
  createRedeploymentRunId: createHandle.id,
  next: "Open this Trigger run. Its output contains the new deploymentId. Then run the orchestrator for that deploymentId.",
}, null, 2));
