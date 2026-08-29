import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const result = await db.query(`
    SELECT a.id AS app_id,
           a.name,
           a.slug,
           a.deleted_at,
           rt.provider,
           rt.provider_project_id,
           rt.provider_project_name,
           rt.status AS runtime_status,
           (SELECT d.status FROM deployments d WHERE d.app_id=a.id ORDER BY d.created_at DESC LIMIT 1) AS latest_deployment_status,
           (SELECT d.id FROM deployments d WHERE d.app_id=a.id ORDER BY d.created_at DESC LIMIT 1) AS latest_deployment_id
      FROM apps a
      LEFT JOIN app_runtimes rt ON rt.app_id=a.id
     ORDER BY a.created_at ASC
  `);

  console.log(JSON.stringify({
    result: "APP_RUNTIME_INVENTORY",
    count: result.rowCount,
    apps: result.rows,
  }, null, 2));
} finally {
  await db.end();
}
