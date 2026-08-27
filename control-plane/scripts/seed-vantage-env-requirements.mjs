import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");

const appSlug = process.env.CONTROL_PLANE_APP_SLUG || "vantage";
const requirements = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "ANTHROPIC_API_KEY",
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "CRON_SECRET",
  "RESEND_API_KEY",
  "NOTIFICATIONS_FROM_EMAIL",
].map((envKey) => ({ envKey, public: envKey.startsWith("NEXT_PUBLIC_") }));

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const appResult = await db.query(
    `SELECT id, workspace_id, slug FROM apps WHERE lower(slug) = lower($1) LIMIT 1`,
    [appSlug],
  );
  if (appResult.rowCount === 0) throw new Error(`App not found: ${appSlug}`);
  const app = appResult.rows[0];

  for (const requirement of requirements) {
    await db.query(
      `INSERT INTO app_env_requirements
         (workspace_id, app_id, env_key, source, required, public)
       VALUES ($1,$2,$3,'source-detection',true,$4)
       ON CONFLICT (app_id, env_key) DO UPDATE SET
         source = EXCLUDED.source,
         required = EXCLUDED.required,
         public = EXCLUDED.public,
         updated_at = now()`,
      [app.workspace_id, app.id, requirement.envKey, requirement.public],
    );
  }

  console.log(JSON.stringify({
    result: "NODE_04_9_REQUIREMENTS_PERSISTED",
    appSlug: app.slug,
    requirementCount: requirements.length,
    requirements,
    valuesStored: false,
  }, null, 2));
} finally {
  await db.end();
}
