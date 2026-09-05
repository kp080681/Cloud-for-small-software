import pg from "pg";
import { requireAppSlug, requireWorkspaceId, resolveAppTarget } from "../src/operator-targeting.mjs";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");

const workspaceId = requireWorkspaceId();
const appSlug = requireAppSlug();
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  const app = await resolveAppTarget(db, { workspaceId, slug: appSlug });

  const secrets = await db.query(
    `SELECT id, name, created_at, updated_at
       FROM encrypted_secrets
      WHERE app_id = $1
      ORDER BY name`,
    [app.id],
  );

  const bindings = await db.query(
    `SELECT b.env_key, b.target_environment, s.name AS secret_name
       FROM app_secret_bindings b
       JOIN encrypted_secrets s
         ON s.id = b.secret_id
        AND s.workspace_id = b.workspace_id
        AND s.app_id = b.app_id
      WHERE b.app_id = $1
      ORDER BY b.env_key`,
    [app.id],
  );

  console.log(JSON.stringify({
    result: "APP_SECRET_INVENTORY",
    app: { id: app.id, name: app.name, slug: app.slug },
    secretCount: secrets.rowCount,
    secrets: secrets.rows,
    bindingCount: bindings.rowCount,
    bindings: bindings.rows,
    plaintextPrinted: false,
  }, null, 2));
} finally {
  await db.end();
}
