import { task } from "@trigger.dev/sdk";
import pg from "pg";

const { Client } = pg;

export const enforceResourcePolicy = task({
  id: "ssc-control-plane-enforce-resource-policy",
  retry: { maxAttempts: 1 },
  run: async (payload: { deploymentId: string }) => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const result = await db.query(
        `SELECT d.id, d.app_id, d.status, a.workspace_id,
                COALESCE(p.policy_tier,'starter') AS policy_tier,
                COALESCE(p.max_build_minutes,15) AS max_build_minutes,
                COALESCE(p.max_env_vars,50) AS max_env_vars,
                COALESCE(p.max_log_events,200) AS max_log_events,
                COALESCE(p.max_health_attempts,3) AS max_health_attempts,
                COALESCE(p.max_deployments_per_day,20) AS max_deployments_per_day,
                (SELECT count(*)::int FROM app_env_requirements r WHERE r.app_id=d.app_id) AS env_requirement_count,
                (SELECT count(*)::int FROM deployments d2 WHERE d2.app_id=d.app_id AND d2.created_at >= now() - interval '24 hours') AS deployments_last_24h
           FROM deployments d
           JOIN apps a ON a.id=d.app_id
           LEFT JOIN app_resource_policies p ON p.app_id=d.app_id
          WHERE d.id=$1`,
        [payload.deploymentId],
      );
      if (result.rowCount === 0) throw new Error(`Deployment not found: ${payload.deploymentId}`);
      const row = result.rows[0];
      const violations: Array<{ code: string; message: string }> = [];
      if (Number(row.env_requirement_count) > Number(row.max_env_vars)) {
        violations.push({ code: "ENV_VAR_LIMIT_EXCEEDED", message: `Application requires ${row.env_requirement_count} environment variables; policy allows ${row.max_env_vars}.` });
      }
      if (Number(row.deployments_last_24h) > Number(row.max_deployments_per_day)) {
        violations.push({ code: "DEPLOYMENT_DAILY_LIMIT_EXCEEDED", message: `Application has ${row.deployments_last_24h} deployments in the last 24 hours; policy allows ${row.max_deployments_per_day}.` });
      }

      if (violations.length > 0) {
        const primary = violations[0];
        await db.query(`UPDATE deployments SET error_code=$1,error_message=$2,updated_at=now() WHERE id=$3`, [primary.code, primary.message, payload.deploymentId]);
        await db.query(
          `INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata)
           VALUES ($1,$2,$2,'RESOURCE_POLICY_BLOCKED',$3,$4::jsonb)`,
          [payload.deploymentId, row.status, primary.message, JSON.stringify({ policyTier: row.policy_tier, violations })],
        );
        return { result: "NODE_04_14_POLICY_BLOCKED", deploymentId: payload.deploymentId, policyTier: row.policy_tier, violations, allowed: false };
      }

      return {
        result: "NODE_04_14_POLICY_VERIFIED",
        deploymentId: payload.deploymentId,
        policyTier: row.policy_tier,
        allowed: true,
        observed: { envRequirementCount: Number(row.env_requirement_count), deploymentsLast24h: Number(row.deployments_last_24h) },
        limits: { maxBuildMinutes: Number(row.max_build_minutes), maxEnvVars: Number(row.max_env_vars), maxLogEvents: Number(row.max_log_events), maxHealthAttempts: Number(row.max_health_attempts), maxDeploymentsPerDay: Number(row.max_deployments_per_day) },
      };
    } finally {
      await db.end();
    }
  },
});
