import { tasks } from "@trigger.dev/sdk";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");
if (!process.env.TRIGGER_SECRET_KEY) throw new Error("Missing required environment variable: TRIGGER_SECRET_KEY");

const appSlug = process.env.CONTROL_PLANE_APP_SLUG || "vantage";
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const result = await db.query(
    `SELECT d.id, d.status, d.live_url
       FROM deployments d
       JOIN apps a ON a.id=d.app_id
      WHERE lower(a.slug)=lower($1)
      ORDER BY d.created_at DESC LIMIT 1`,
    [appSlug],
  );
  if (result.rowCount === 0) throw new Error(`No deployment found for app slug: ${appSlug}`);
  const deployment = result.rows[0];
  const handle = await tasks.trigger("ssc-control-plane-configure-public-access", { deploymentId: deployment.id });
  console.log(JSON.stringify({
    result: "NODE_04_11_PUBLIC_ACCESS_TRIGGERED",
    appSlug,
    deploymentId: deployment.id,
    status: deployment.status,
    liveUrl: deployment.live_url,
    triggerRunId: handle.id,
  }, null, 2));
} finally {
  await db.end();
}
