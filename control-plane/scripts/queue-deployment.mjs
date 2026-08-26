import pg from "pg";
import { tasks } from "@trigger.dev/sdk";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");

const deploymentKey = process.env.CONTROL_PLANE_DEPLOYMENT_KEY;
if (!deploymentKey) throw new Error("Missing required environment variable: CONTROL_PLANE_DEPLOYMENT_KEY");

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  await db.query("BEGIN");

  const current = await db.query(
    `SELECT id, deployment_key, status, orchestrator_run_id
       FROM deployments
      WHERE deployment_key = $1
      FOR UPDATE`,
    [deploymentKey],
  );
  if (current.rowCount === 0) throw new Error(`Deployment not found: ${deploymentKey}`);
  const deployment = current.rows[0];

  if (deployment.status === "READY") {
    await db.query(
      `UPDATE deployments
          SET status = 'QUEUED', queued_at = COALESCE(queued_at, now()), updated_at = now()
        WHERE id = $1`,
      [deployment.id],
    );
    await db.query(
      `INSERT INTO deployment_events
         (deployment_id, from_status, to_status, event_type, message)
       VALUES ($1, 'READY', 'QUEUED', 'STATUS_CHANGED', 'Deployment queued for durable execution')`,
      [deployment.id],
    );
  } else if (!["QUEUED", "ANALYZING"].includes(deployment.status)) {
    throw new Error(`Deployment cannot be queued from status ${deployment.status}`);
  }

  await db.query("COMMIT");

  // Trigger only after canonical QUEUED state is committed. If this call fails, rerunning
  // this command is safe: QUEUED is preserved and the task can be submitted again.
  const handle = await tasks.trigger("ssc-control-plane-analyze-deployment", {
    deploymentId: deployment.id,
  });

  await db.query(
    `UPDATE deployments
        SET orchestrator_run_id = COALESCE(orchestrator_run_id, $1), updated_at = now()
      WHERE id = $2`,
    [handle.id, deployment.id],
  );

  console.log(JSON.stringify({
    result: "NODE_04_5_QUEUED",
    deploymentId: deployment.id,
    deploymentKey,
    status: "QUEUED",
    triggerRunId: handle.id,
  }, null, 2));
} catch (error) {
  try { await db.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  await db.end();
}
