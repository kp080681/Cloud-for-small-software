import { task, tasks, wait } from "@trigger.dev/sdk";
import pg from "pg";

const { Client } = pg;
const BUILD_POLL_SECONDS = 15;
const HEALTH_RETRY_SECONDS = 10;

async function deploymentSnapshot(deploymentId: string) {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const result = await db.query(
      `SELECT d.id, d.app_id, d.status, d.error_code, d.error_message,
              b.provider_deployment_id, b.status AS build_status,
              COALESCE(p.max_build_minutes,15) AS max_build_minutes,
              COALESCE(p.max_health_attempts,3) AS max_health_attempts
         FROM deployments d
         LEFT JOIN deployment_builds b ON b.deployment_id=d.id
         LEFT JOIN app_resource_policies p ON p.app_id=d.app_id
        WHERE d.id=$1`,
      [deploymentId],
    );
    if (result.rowCount === 0) throw new Error(`Deployment not found: ${deploymentId}`);
    return result.rows[0];
  } finally {
    await db.end();
  }
}

async function failBuildTimeout(deploymentId: string, maxBuildMinutes: number) {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    try {
      await db.query(
        `UPDATE deployments
            SET status='FAILED', error_code='BUILD_TIMEOUT',
                error_message=$1, finished_at=now(), updated_at=now()
          WHERE id=$2 AND status='BUILDING'`,
        [`Application build exceeded the ${maxBuildMinutes}-minute resource policy limit.`, deploymentId],
      );
      await db.query(
        `UPDATE deployment_builds SET status='POLICY_TIMEOUT', updated_at=now() WHERE deployment_id=$1`,
        [deploymentId],
      );
      await db.query(
        `INSERT INTO deployment_events
           (deployment_id,from_status,to_status,event_type,message,metadata)
         VALUES ($1,'BUILDING','FAILED','BUILD_TIMEOUT',$2,$3::jsonb)`,
        [deploymentId, `Application build exceeded the ${maxBuildMinutes}-minute resource policy limit.`, JSON.stringify({ maxBuildMinutes })],
      );
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  } finally {
    await db.end();
  }
}

export const orchestrateDeployment = task({
  id: "ssc-control-plane-orchestrate-deployment",
  retry: { maxAttempts: 1 },
  run: async (payload: { deploymentId: string }) => {
    let current = await deploymentSnapshot(payload.deploymentId);

    if (["LIVE", "FAILED", "DELETED"].includes(current.status)) {
      return {
        result: "NODE_04_15_TERMINAL_NOOP",
        deploymentId: payload.deploymentId,
        status: current.status,
        errorCode: current.error_code,
      };
    }

    if (current.status === "BUILDING" && !current.provider_deployment_id) {
      const policy = await tasks.triggerAndWait("ssc-control-plane-enforce-resource-policy", { deploymentId: payload.deploymentId });
      if (!policy.ok) throw new Error("Resource policy task failed");
      const policyOutput: any = policy.output;
      if (policyOutput?.allowed !== true) {
        return {
          result: "NODE_04_15_POLICY_BLOCKED",
          deploymentId: payload.deploymentId,
          status: "BUILDING",
          policy: policyOutput,
        };
      }

      const build = await tasks.triggerAndWait("ssc-control-plane-execute-build", { deploymentId: payload.deploymentId });
      if (!build.ok) throw new Error("Build execution task failed");
      const buildOutput: any = build.output;
      if (buildOutput?.result === "NODE_04_10_BLOCKED_EXTERNAL_QUOTA") {
        return {
          result: "NODE_04_15_PROVIDER_BLOCKED",
          deploymentId: payload.deploymentId,
          status: "BUILDING",
          providerResult: buildOutput,
        };
      }
    }

    current = await deploymentSnapshot(payload.deploymentId);

    if (current.status === "BUILDING" && current.provider_deployment_id) {
      const buildStartedAt = Date.now();
      const buildDeadlineMs = Number(current.max_build_minutes) * 60_000;

      while (true) {
        const reconcile = await tasks.triggerAndWait("ssc-control-plane-reconcile-build", { deploymentId: payload.deploymentId });
        if (!reconcile.ok) throw new Error("Build reconciliation task failed");
        const reconcileOutput: any = reconcile.output;

        if (reconcileOutput?.result === "NODE_04_10_BUILD_VERIFIED") break;

        if (["NODE_04_10_BUILD_FAILED", "NODE_04_10_SOURCE_MISMATCH"].includes(reconcileOutput?.result)) {
          await tasks.triggerAndWait("ssc-control-plane-ingest-build-logs", { deploymentId: payload.deploymentId });
          const failed = await deploymentSnapshot(payload.deploymentId);
          return {
            result: "NODE_04_15_FAILED",
            deploymentId: payload.deploymentId,
            status: failed.status,
            errorCode: failed.error_code,
          };
        }

        if (Date.now() - buildStartedAt >= buildDeadlineMs) {
          await tasks.triggerAndWait("ssc-control-plane-ingest-build-logs", { deploymentId: payload.deploymentId });
          await failBuildTimeout(payload.deploymentId, Number(current.max_build_minutes));
          return {
            result: "NODE_04_15_BUILD_TIMEOUT",
            deploymentId: payload.deploymentId,
            status: "FAILED",
            errorCode: "BUILD_TIMEOUT",
            maxBuildMinutes: Number(current.max_build_minutes),
          };
        }

        await wait.for({ seconds: BUILD_POLL_SECONDS });
      }

      const logs = await tasks.triggerAndWait("ssc-control-plane-ingest-build-logs", { deploymentId: payload.deploymentId });
      if (!logs.ok) throw new Error("Build log ingestion task failed");
    }

    current = await deploymentSnapshot(payload.deploymentId);

    if (current.status === "DEPLOYING" || current.status === "HEALTH_CHECKING") {
      while (true) {
        const health = await tasks.triggerAndWait("ssc-control-plane-health-check", { deploymentId: payload.deploymentId });
        if (!health.ok) throw new Error("Health check task failed");
        const healthOutput: any = health.output;

        if (healthOutput?.status === "LIVE") {
          return {
            result: "NODE_04_15_LIVE",
            deploymentId: payload.deploymentId,
            status: "LIVE",
            liveUrl: healthOutput.liveUrl,
            health: healthOutput,
          };
        }

        if (healthOutput?.status === "FAILED") {
          return {
            result: "NODE_04_15_FAILED",
            deploymentId: payload.deploymentId,
            status: "FAILED",
            health: healthOutput,
          };
        }

        await wait.for({ seconds: HEALTH_RETRY_SECONDS });
      }
    }

    current = await deploymentSnapshot(payload.deploymentId);
    return {
      result: current.status === "LIVE" ? "NODE_04_15_LIVE" : current.status === "FAILED" ? "NODE_04_15_FAILED" : "NODE_04_15_WAITING",
      deploymentId: payload.deploymentId,
      status: current.status,
      buildStatus: current.build_status,
      providerDeploymentId: current.provider_deployment_id,
      errorCode: current.error_code,
    };
  },
});
