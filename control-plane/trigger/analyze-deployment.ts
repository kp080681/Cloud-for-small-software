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

async function transition(db: pg.Client, deploymentId: string, from: string, to: string, message: string) {
  const result = await db.query(
    `UPDATE deployments
        SET status = $1,
            started_at = COALESCE(started_at, now()),
            updated_at = now()
      WHERE id = $2 AND status = $3
      RETURNING id, deployment_key, status, attempt_count`,
    [to, deploymentId, from],
  );

  if (result.rowCount === 1) {
    await db.query(
      `INSERT INTO deployment_events
         (deployment_id, from_status, to_status, event_type, message)
       VALUES ($1, $2, $3, 'STATUS_CHANGED', $4)`,
      [deploymentId, from, to, message],
    );
    return { changed: true, deployment: result.rows[0] };
  }

  const current = await db.query(
    `SELECT id, deployment_key, status, attempt_count FROM deployments WHERE id = $1`,
    [deploymentId],
  );
  if (current.rowCount === 0) throw new Error(`Deployment not found: ${deploymentId}`);
  return { changed: false, deployment: current.rows[0] };
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
        const attempt = await db.query(
          `UPDATE deployments
              SET attempt_count = attempt_count + 1,
                  updated_at = now()
            WHERE id = $1
            RETURNING id, deployment_key, status, attempt_count, source_commit_sha`,
          [payload.deploymentId],
        );
        if (attempt.rowCount === 0) throw new Error(`Deployment not found: ${payload.deploymentId}`);

        const transitionResult = await transition(
          db,
          payload.deploymentId,
          "QUEUED",
          "ANALYZING",
          "Durable worker claimed deployment for analysis",
        );

        await db.query("COMMIT");

        return {
          result: "NODE_04_5_ANALYZED",
          deploymentId: payload.deploymentId,
          deploymentKey: transitionResult.deployment.deployment_key,
          status: transitionResult.deployment.status,
          attemptCount: attempt.rows[0].attempt_count,
          stateTransitionWritten: transitionResult.changed,
          commitSha: attempt.rows[0].source_commit_sha,
        };
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    });
  },
});
