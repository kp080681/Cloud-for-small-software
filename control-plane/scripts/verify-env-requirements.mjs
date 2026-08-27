import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");
const appSlug = process.env.CONTROL_PLANE_APP_SLUG || "vantage";
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const result = await db.query(
    `SELECT r.env_key, r.required, r.public, r.source,
            b.id IS NOT NULL AS configured
       FROM app_env_requirements r
       JOIN apps a ON a.id = r.app_id
       LEFT JOIN app_secret_bindings b
         ON b.app_id = r.app_id
        AND b.env_key = r.env_key
        AND b.target_environment = 'production'
      WHERE lower(a.slug) = lower($1)
      ORDER BY r.env_key`,
    [appSlug],
  );
  const requirements = result.rows.map((row) => ({
    envKey: row.env_key,
    required: row.required,
    public: row.public,
    source: row.source,
    configured: row.configured,
  }));
  const missing = requirements.filter((item) => item.required && !item.configured).map((item) => item.envKey);
  console.log(JSON.stringify({
    result: missing.length ? "NODE_04_9_ENV_INPUT_REQUIRED" : "NODE_04_9_ENV_READY",
    appSlug,
    requirementCount: requirements.length,
    configuredCount: requirements.length - missing.length,
    missingCount: missing.length,
    requirements,
    missing,
    valuesPrinted: false,
  }, null, 2));
} finally {
  await db.end();
}
