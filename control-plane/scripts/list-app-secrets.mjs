import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");

const appSlug = process.env.CONTROL_PLANE_APP_SLUG || "vantage";
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  const appResult = await db.query(
    `SELECT id, name, slug FROM apps WHERE lower(slug) = lower($1) LIMIT 1`,
    [appSlug],
  );
  if (appResult.rowCount === 0) throw new Error(`App not found: ${appSlug}`);
  const app = appResult.rows[0];

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
       JOIN encrypted_secrets s ON s.id = b.secret_id
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
