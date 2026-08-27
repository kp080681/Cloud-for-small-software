import { task, tasks } from "@trigger.dev/sdk";
import pg from "pg";

const { Client } = pg;

async function deploymentSnapshot(deploymentId: string) {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const result = await db.query(
      `SELECT d.id, d.status, d.error_code, d.error_message,
              b.provider_deployment_id, b.status AS build_status
         FROM deployments d
         LEFT JOIN deployment_builds b ON b.deployment_id=d.id
        WHERE d.id=$1`,
      [deploymentId],
    );
    if (result.rowCount === 0) throw new Error(`Deployment not found: ${deploymentId}`);
    return result.rows[0];
  } finally {
    await db.end();
  }
}

export const orchestrateDeployment = task({
  id: "ssc-control-plane-orchestrate-deployment",
  retry: { maxAttempts: 1 },
  run: async (payload: { deploymentId: string }) => {
    const before = await deploymentSnapshot(payload.deploymentId);

    if (before.status === "LIVE" || before.status === "FAILED" || before.status === "DELETED") {
      return {
        result: "NODE_04_15_TERMINAL_NOOP",
        deploymentId: payload.deploymentId,
        status: before.status,
        errorCode: before.error_code,
      };
    }

    if (before.status === "BUILDING" && !before.provider_deployment_id) {
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

    let current = await deploymentSnapshot(payload.deploymentId);

    if (current.status === "BUILDING" && current.provider_deployment_id) {
      const logs = await tasks.triggerAndWait("ssc-control-plane-ingest-build-logs", { deploymentId: payload.deploymentId });
      if (!logs.ok) throw new Error("Build log ingestion task failed");

      const reconcile = await tasks.triggerAndWait("ssc-control-plane-reconcile-build", { deploymentId: payload.deploymentId });
      if (!reconcile.ok) throw new Error("Build reconciliation task failed");
      const reconcileOutput: any = reconcile.output;
      if (reconcileOutput?.result === "NODE_04_10_BUILD_PENDING") {
        return {
          result: "NODE_04_15_BUILD_PENDING",
          deploymentId: payload.deploymentId,
          status: "BUILDING",
          providerStatus: reconcileOutput.providerStatus,
          providerDeploymentId: reconcileOutput.providerDeploymentId,
        };
      }
    }

    current = await deploymentSnapshot(payload.deploymentId);

    if (current.status === "DEPLOYING" || current.status === "HEALTH_CHECKING") {
      const health = await tasks.triggerAndWait("ssc-control-plane-health-check", { deploymentId: payload.deploymentId });
      if (!health.ok) throw new Error("Health check task failed");
      const healthOutput: any = health.output;
      return {
        result: healthOutput?.status === "LIVE" ? "NODE_04_15_LIVE" : healthOutput?.status === "FAILED" ? "NODE_04_15_FAILED" : "NODE_04_15_HEALTH_PENDING",
        deploymentId: payload.deploymentId,
        status: healthOutput?.status,
        health: healthOutput,
      };
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
