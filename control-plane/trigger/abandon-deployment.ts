import { task } from "@trigger.dev/sdk";
import pg from "pg";
import { recordRemoteBuildContainment } from "../src/vercel-deployment-cancellation.mjs";

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
      await db.query("BEGIN");
      const result = await db.query(
        `SELECT d.id, d.app_id, d.status, d.error_code,
                COALESCE(b.provider_deployment_id, o.provider_resource_id) AS provider_deployment_id,
                o.provider_resource_id AS operation_provider_deployment_id
           FROM deployments d
           LEFT JOIN deployment_builds b ON b.deployment_id=d.id
           LEFT JOIN LATERAL (
             SELECT provider_resource_id
               FROM deployment_provider_operations
              WHERE deployment_id=d.id
                AND operation_type='vercel-create-deployment'
                AND provider='vercel'
                AND status IN ('OBSERVED_STALE','OBSERVED')
                AND provider_resource_id IS NOT NULL
              ORDER BY updated_at DESC, id DESC
              LIMIT 1
           ) o ON true
          WHERE d.id=$1
          FOR UPDATE OF d`,
        [payload.deploymentId],
      );
      if (result.rowCount === 0) throw new Error(`Deployment not found: ${payload.deploymentId}`);
      const row = result.rows[0];

      if (["LIVE","FAILED","DELETED"].includes(row.status)) {
        await db.query("COMMIT");
        let remoteContainment = null;
        if (row.status === "FAILED" && row.error_code === "DEPLOYMENT_ABANDONED" && row.provider_deployment_id) {
          remoteContainment = await recordRemoteBuildContainment(db, {
            deploymentId: payload.deploymentId,
            fromStatus: "FAILED",
            providerDeploymentId: row.provider_deployment_id,
            reason: "DEPLOYMENT_ABANDONED",
          });
        }
        return {
          result: "DEPLOYMENT_ABANDON_TERMINAL_NOOP",
          deploymentId: payload.deploymentId,
          status: row.status,
          errorCode: row.error_code,
          remoteContainment: remoteContainment?.outcome ?? null,
        };
      }
      if (!ABANDONABLE.has(row.status)) throw new Error(`Deployment cannot be abandoned from status ${row.status}`);

      const reason = String(payload.reason || "Deployment abandoned by control-plane operator after superseded lifecycle test.").slice(0, 500);
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
          [payload.deploymentId, row.status, reason, JSON.stringify({ operatorInitiated: true, providerResourcesDeleted: false, providerDeploymentId: row.provider_deployment_id ?? null })],
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }

      const remoteContainment = row.provider_deployment_id
        ? await recordRemoteBuildContainment(db, {
            deploymentId: payload.deploymentId,
            fromStatus: "FAILED",
            providerDeploymentId: row.provider_deployment_id,
            reason: "DEPLOYMENT_ABANDONED",
          })
        : null;

      return {
        result: "DEPLOYMENT_ABANDONED",
        deploymentId: payload.deploymentId,
        appId: row.app_id,
        previousStatus: row.status,
        status: "FAILED",
        errorCode: "DEPLOYMENT_ABANDONED",
        providerResourcesDeleted: false,
        remoteContainment: remoteContainment?.outcome ?? null,
      };
    } catch (error) {
      try { await db.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      await db.end();
    }
  },
});
