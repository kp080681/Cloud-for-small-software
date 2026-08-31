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

export const verifyEnvRequirements = task({
  id: "ssc-control-plane-verify-env-requirements",
  retry: { maxAttempts: 1 },
  run: async (payload: { deploymentId: string }) => {
    return await withDb(async (db) => {
      const deploymentResult = await db.query(
        `SELECT d.id, d.workspace_id, d.app_id, d.status,
                s.id AS snapshot_id, s.detected_count
           FROM deployments d
           LEFT JOIN deployment_env_detection_snapshots s ON s.deployment_id = d.id
          WHERE d.id = $1`,
        [payload.deploymentId],
      );
      if (deploymentResult.rowCount === 0) throw new Error(`Deployment not found: ${payload.deploymentId}`);
      const deployment = deploymentResult.rows[0];
      if (deployment.status !== "ANALYZING") throw new Error(`Environment requirements can only be verified from ANALYZING; current status is ${deployment.status}`);
      if (!deployment.snapshot_id) throw new Error(`Environment detection snapshot not found: ${payload.deploymentId}`);

      const requirementResult = await db.query(
        `SELECT r.env_key, r.required, r.public, r.source,
                b.id IS NOT NULL AS configured
           FROM app_env_requirements r
           LEFT JOIN app_secret_bindings b
             ON b.app_id = r.app_id
            AND b.env_key = r.env_key
            AND b.target_environment = 'production'
          WHERE r.app_id = $1
          ORDER BY r.env_key`,
        [deployment.app_id],
      );

      const requirements = requirementResult.rows.map((row) => ({
        envKey: row.env_key,
        required: row.required,
        public: row.public,
        source: row.source,
        configured: row.configured,
      }));
      const configuredCount = requirements.filter((item) => item.configured).length;
      const missing = requirements.filter((item) => item.required && !item.configured).map((item) => item.envKey);

      await db.query("BEGIN");
      try {
        if (missing.length) {
          const message = `Required runtime variables are not configured: ${missing.join(", ")}`;
          await db.query(
            `UPDATE deployments
                SET error_code = 'ENV_CONFIGURATION_REQUIRED',
                    error_message = $1,
                    updated_at = now()
              WHERE id = $2 AND status = 'ANALYZING'`,
            [message, payload.deploymentId],
          );
          await db.query(
            `INSERT INTO deployment_events
               (deployment_id, from_status, to_status, event_type, message, metadata)
             VALUES ($1,'ANALYZING','ANALYZING','ENV_REQUIREMENTS_BLOCKED',$2,$3::jsonb)`,
            [payload.deploymentId, message, JSON.stringify({
              snapshotId: deployment.snapshot_id,
              requirementCount: requirements.length,
              missingCount: missing.length,
              missingKeys: missing,
              valuesPrinted: false,
            })],
          );
          await db.query("COMMIT");
          return {
            result: "NODE_04_17_ENV_CONFIGURATION_REQUIRED",
            deploymentId: payload.deploymentId,
            status: "ANALYZING",
            requirementCount: requirements.length,
            missingCount: missing.length,
            missingKeys: missing,
            valuesPrinted: false,
          };
        }

        const advanced = await db.query(
          `UPDATE deployments
              SET status = 'PROVISIONING',
                  error_code = NULL,
                  error_message = NULL,
                  updated_at = now()
            WHERE id = $1 AND status = 'ANALYZING'
            RETURNING id`,
          [payload.deploymentId],
        );
        if (advanced.rowCount === 1) {
          await db.query(
            `INSERT INTO deployment_events
               (deployment_id, from_status, to_status, event_type, message, metadata)
             VALUES ($1,'ANALYZING','PROVISIONING','ENV_REQUIREMENTS_VERIFIED',
                     'Required environment configuration verified before provisioning', $2::jsonb)`,
            [payload.deploymentId, JSON.stringify({
              snapshotId: deployment.snapshot_id,
              requirementCount: requirements.length,
              configuredCount,
              detectedCount: Number(deployment.detected_count),
              valuesPrinted: false,
            })],
          );
        }
        await db.query("COMMIT");

        return {
          result: "NODE_04_17_ENV_REQUIREMENTS_VERIFIED",
          deploymentId: payload.deploymentId,
          status: "PROVISIONING",
          requirementCount: requirements.length,
          configuredCount,
          detectedCount: Number(deployment.detected_count),
          valuesPrinted: false,
        };
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    });
  },
});
