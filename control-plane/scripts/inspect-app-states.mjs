import pg from "pg";

// Read-only diagnostic: shows the RAW state of every app in a workspace —
// the actual error_code, status, and framework/runtime detection results —
// bypassing every friendly-message translation layer. Built to investigate
// why some repos in the dashboard show generic or unexpected messages.
for (const name of ["DATABASE_URL"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const apps = await db.query(`
    SELECT
      a.id,
      a.name,
      a.slug,
      a.framework,
      a.runtime,
      a.database_required,
      r.full_name AS repository_full_name,
      d.id AS deployment_id,
      d.status AS deployment_status,
      d.error_code AS deployment_error_code,
      d.error_message AS deployment_error_message,
      d.live_url,
      d.provider_deployment_id,
      d.runtime_project_id,
      d.created_at AS deployment_created_at,
      d.updated_at AS deployment_updated_at
    FROM apps a
    JOIN github_repositories r ON r.id = a.repository_id
    LEFT JOIN LATERAL (
      SELECT id, status, error_code, error_message, live_url, provider_deployment_id, runtime_project_id, created_at, updated_at
      FROM deployments
      WHERE app_id = a.id
      ORDER BY created_at DESC
      LIMIT 1
    ) d ON true
    WHERE a.deleted_at IS NULL
    ORDER BY a.created_at DESC
  `);

  console.log(JSON.stringify(apps.rows, null, 2));
} finally {
  await db.end();
}
