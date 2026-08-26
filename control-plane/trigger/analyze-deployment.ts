import { task } from "@trigger.dev/sdk";
import pg from "pg";

const { Client } = pg;

async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

export const analyzeDeployment = task({
  id: "ssc-control-plane-analyze-deployment",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 10000,
    factor: 2,
    randomize: false,
  },
  run: async (payload: { deploymentId: string }) => {
    return await withDb(async (db) => {
      await db.query("BEGIN");
      try {
        // Claim and count the attempt atomically. A replay after the deployment has
        // already reached ANALYZING must not increment attempt_count or duplicate events.
        const claimed = await db.query(
          `UPDATE deployments
              SET status = 'ANALYZING',
                  attempt_count = attempt_count + 1,
                  started_at = COALESCE(started_at, now()),
                  updated_at = now()
            WHERE id = $1 AND status = 'QUEUED'
            RETURNING id, deployment_key, status, attempt_count, source_commit_sha`,
          [payload.deploymentId],
        );

        if (claimed.rowCount === 1) {
          const deployment = claimed.rows[0];
          await db.query(
            `INSERT INTO deployment_events
               (deployment_id, from_status, to_status, event_type, message)
             VALUES ($1, 'QUEUED', 'ANALYZING', 'STATUS_CHANGED',
                     'Durable worker claimed deployment for analysis')`,
            [payload.deploymentId],
          );

          await db.query("COMMIT");
          return {
            result: "NODE_04_5_ANALYZED",
            deploymentId: payload.deploymentId,
            deploymentKey: deployment.deployment_key,
            status: deployment.status,
            attemptCount: deployment.attempt_count,
            stateTransitionWritten: true,
            replayNoOp: false,
            commitSha: deployment.source_commit_sha,
          };
        }

        const current = await db.query(
          `SELECT id, deployment_key, status, attempt_count, source_commit_sha
             FROM deployments
            WHERE id = $1`,
          [payload.deploymentId],
        );
        if (current.rowCount === 0) throw new Error(`Deployment not found: ${payload.deploymentId}`);

        const deployment = current.rows[0];
        if (deployment.status !== "ANALYZING") {
          throw new Error(`Analysis worker cannot claim deployment from status ${deployment.status}`);
        }

        await db.query("COMMIT");
        return {
          result: "NODE_04_5_REPLAY_NOOP",
          deploymentId: payload.deploymentId,
          deploymentKey: deployment.deployment_key,
          status: deployment.status,
          attemptCount: deployment.attempt_count,
          stateTransitionWritten: false,
          replayNoOp: true,
          commitSha: deployment.source_commit_sha,
        };
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    });
  },
});
