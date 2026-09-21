import pg from "pg";
import { optionalAppId, requireAppSlug, requireWorkspaceId, resolveAppTarget } from "../src/operator-targeting.mjs";

// Manual resume for an app auto-paused by the failure-cooldown containment
// (see src/deployment-failure-cooldown.mjs). Deliberately requires an
// operator to run this explicitly — pausing does not expire on its own, by
// design, so a customer can't accidentally sail past a real recurring
// problem just because 15 minutes went by.
for (const name of ["DATABASE_URL"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const workspaceId = requireWorkspaceId();
const appId = optionalAppId();
const appSlug = appId ? null : requireAppSlug();
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  const app = await resolveAppTarget(db, { workspaceId, appId, slug: appSlug });
  const result = await db.query(
    `UPDATE apps SET paused_at=NULL, paused_reason=NULL, updated_at=now()
      WHERE id=$1 AND workspace_id=$2
      RETURNING id, name, slug, paused_at`,
    [app.id, workspaceId],
  );
  if (result.rowCount === 0) {
    throw new Error(`App not found in the requested workspace: ${app.id}`);
  }
  console.log(JSON.stringify({
    result: "APP_RESUMED",
    appId: result.rows[0].id,
    appName: result.rows[0].name,
    appSlug: result.rows[0].slug,
  }, null, 2));
} finally {
  await db.end();
}
