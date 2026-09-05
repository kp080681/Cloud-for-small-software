import crypto from "node:crypto";
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
  app = await resolveAppTarget(db, { workspaceId, appId, slug: appSlug, includeDeleted: true });
  if (app.deleted_at) throw new Error(`App is already deleted: ${app.slug}`);
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
