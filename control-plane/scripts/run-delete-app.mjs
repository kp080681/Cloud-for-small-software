import crypto from "node:crypto";
import pg from "pg";
import { tasks } from "@trigger.dev/sdk";

for (const name of ["DATABASE_URL", "TRIGGER_SECRET_KEY"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const appSlug = (process.env.CONTROL_PLANE_APP_SLUG || "").toLowerCase();
if (!appSlug) throw new Error("Missing CONTROL_PLANE_APP_SLUG");

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let app;
try {
  const result = await db.query(
    `SELECT id, workspace_id, name, slug, deleted_at
       FROM apps
      WHERE lower(slug)=lower($1)
      LIMIT 1`,
    [appSlug],
  );
  if (result.rowCount === 0) throw new Error(`App not found for slug: ${appSlug}`);
  app = result.rows[0];
  if (app.deleted_at) throw new Error(`App is already deleted: ${appSlug}`);
} finally {
  await db.end();
}

const deletionKey = `del_${crypto.randomUUID().replaceAll("-", "")}`;
const handle = await tasks.trigger("ssc-control-plane-delete-app", {
  appId: app.id,
  workspaceId: app.workspace_id,
  deletionKey,
});

console.log(JSON.stringify({
  result: "NODE_04_13_DELETE_REQUESTED",
  appId: app.id,
  appName: app.name,
  appSlug: app.slug,
  workspaceId: app.workspace_id,
  deletionKey,
  triggerRunId: handle.id,
}, null, 2));
