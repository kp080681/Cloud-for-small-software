import { task } from "@trigger.dev/sdk";
import pg from "pg";

const { Client } = pg;
const ABANDONABLE = new Set(["DRAFT","READY","QUEUED","ANALYZING","PROVISIONING","BUILDING","DEPLOYING","HEALTH_CHECKING"]);

export const abandonDeployment = task({
  id: "ssc-control-plane-abandon-deployment",
  retry: { maxAttempts: 1 },
  run: async (payload: { deploymentId: string; reason?: string }) => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const result = await db.query(
        `SELECT id, app_id, status, error_code FROM deployments WHERE id=$1 FOR UPDATE`,
        [payload.deploymentId],
      );
      if (result.rowCount === 0) throw new Error(`Deployment not found: ${payload.deploymentId}`);
      const row = result.rows[0];

      if (["LIVE","FAILED","DELETED"].includes(row.status)) {
        return {
          result: "DEPLOYMENT_ABANDON_TERMINAL_NOOP",
          deploymentId: payload.deploymentId,
          status: row.status,
          errorCode: row.error_code,
        };
      }
      if (!ABANDONABLE.has(row.status)) throw new Error(`Deployment cannot be abandoned from status ${row.status}`);

      const reason = String(payload.reason || "Deployment abandoned by control-plane operator after superseded lifecycle test.").slice(0, 500);
      await db.query("BEGIN");
      try {
        await db.query(
          `UPDATE deployments
              SET status='FAILED',
                  error_code='DEPLOYMENT_ABANDONED',
                  error_message=$1,
                  finished_at=COALESCE(finished_at,now()),
                  updated_at=now()
            WHERE id=$2`,
          [reason, payload.deploymentId],
        );
        await db.query(
          `INSERT INTO deployment_events
             (deployment_id,from_status,to_status,event_type,message,metadata)
           VALUES ($1,$2,'FAILED','DEPLOYMENT_ABANDONED',$3,$4::jsonb)`,
          [payload.deploymentId, row.status, reason, JSON.stringify({ operatorInitiated: true, providerResourcesDeleted: false })],
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }

      return {
        result: "DEPLOYMENT_ABANDONED",
        deploymentId: payload.deploymentId,
        appId: row.app_id,
        previousStatus: row.status,
        status: "FAILED",
        errorCode: "DEPLOYMENT_ABANDONED",
        providerResourcesDeleted: false,
      };
    } finally {
      await db.end();
    }
  },
});
