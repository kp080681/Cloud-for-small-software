import pg from "pg";

// Read-only diagnostic: shows the FULL event history for one deployment,
// plus its own raw row — for tracing exactly which step a stuck deployment
// is stuck at, beyond what inspect-app-states.mjs's summary view shows.
for (const name of ["DATABASE_URL", "DEPLOYMENT_ID"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const deployment = await db.query(
    `SELECT id, app_id, status, error_code, error_message, orchestrator_run_id,
            provider_deployment_id, live_url, source_commit_sha, parent_deployment_id,
            created_at, updated_at
       FROM deployments WHERE id = $1`,
    [process.env.DEPLOYMENT_ID],
  );

  const events = await db.query(
    `SELECT id, event_type, from_status, to_status, message, metadata, created_at
       FROM deployment_events
      WHERE deployment_id = $1
      ORDER BY created_at ASC`,
    [process.env.DEPLOYMENT_ID],
  );

  console.log(JSON.stringify({ deployment: deployment.rows[0] ?? null, events: events.rows }, null, 2));
} finally {
  await db.end();
}
