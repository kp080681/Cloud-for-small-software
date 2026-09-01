import { task } from "@trigger.dev/sdk";
import pg from "pg";
import { buildReconciliationAction, isRecoveryTerminalStatus } from "../src/deployment-recovery-rules.mjs";

const { Client } = pg;
const API = "https://api.vercel.com";

function teamQuery() {
  return process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : "";
}

async function getVercelDeployment(id: string) {
  if (!process.env.VERCEL_TOKEN) throw new Error("Missing VERCEL_TOKEN");
  const response = await fetch(`${API}/v13/deployments/${encodeURIComponent(id)}${teamQuery()}`, {
    headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Vercel deployment lookup failed: ${response.status} ${response.statusText}`);
  return response.json();
}

function providerCommitSha(deployment: any) {
  return deployment?.meta?.githubCommitSha
    ?? deployment?.gitSource?.sha
    ?? deployment?.gitSource?.ref
    ?? deployment?.meta?.sscSourceCommitSha
    ?? null;
}

export const reconcileBuild = task({
  id: "ssc-control-plane-reconcile-build",
  retry: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 10000, factor: 2, randomize: false },
  run: async (payload: { deploymentId: string }) => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const result = await db.query(
        `SELECT d.status AS deployment_status, b.provider_deployment_id, b.provider_deployment_url,
                b.source_commit_sha, b.status AS build_status
           FROM deployment_builds b
           JOIN deployments d ON d.id=b.deployment_id
          WHERE b.deployment_id=$1`,
        [payload.deploymentId],
      );
      if (result.rowCount === 0) {
        return { result: "NODE_04_10_BUILD_NOT_CREATED", deploymentId: payload.deploymentId };
      }
      const build = result.rows[0];
      if (isRecoveryTerminalStatus(build.deployment_status)) {
        return { result: "NODE_04_18_TERMINAL_NOOP", deploymentId: payload.deploymentId, status: build.deployment_status };
      }
      const provider = await getVercelDeployment(build.provider_deployment_id);
      const providerStatus = provider?.readyState ?? provider?.status ?? "UNKNOWN";
      const observedSha = providerCommitSha(provider);
      const sourceIdentityMatches = observedSha === build.source_commit_sha;

      if (observedSha && !sourceIdentityMatches) {
        await db.query("BEGIN");
        try {
          await db.query(`UPDATE deployment_builds SET status='SOURCE_MISMATCH', updated_at=now() WHERE deployment_id=$1`, [payload.deploymentId]);
          await db.query(`UPDATE deployments SET status='FAILED', error_code='BUILD_SOURCE_MISMATCH', error_message='Provider build source did not match the immutable deployment source.', finished_at=now(), updated_at=now() WHERE id=$1 AND status='BUILDING'`, [payload.deploymentId]);
          await db.query(
            `INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata)
             VALUES ($1,'BUILDING','FAILED','BUILD_SOURCE_MISMATCH','Provider build source identity mismatch',$2::jsonb)`,
            [payload.deploymentId, JSON.stringify({ expectedCommitSha: build.source_commit_sha, observedCommitSha: observedSha })],
          );
          await db.query("COMMIT");
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        }
        return { result: "NODE_04_10_SOURCE_MISMATCH", deploymentId: payload.deploymentId, expectedCommitSha: build.source_commit_sha, observedCommitSha: observedSha };
      }

      const action = buildReconciliationAction({ deploymentStatus: build.deployment_status, providerStatus });
      const terminalSuccess = action.action === "advance-deploying";
      const terminalFailure = action.action === "fail-build";
      await db.query("BEGIN");
      try {
        await db.query(`UPDATE deployment_builds SET status=$1, provider_deployment_url=COALESCE($2,provider_deployment_url), updated_at=now() WHERE deployment_id=$3`, [providerStatus, provider?.url ? `https://${provider.url}` : null, payload.deploymentId]);

        if (terminalSuccess) {
          const advanced = await db.query(`UPDATE deployments SET status='DEPLOYING', error_code=NULL, error_message=NULL, updated_at=now() WHERE id=$1 AND status='BUILDING' RETURNING id`, [payload.deploymentId]);
          if (advanced.rowCount === 1) await db.query(
            `INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata)
             VALUES ($1,'BUILDING','DEPLOYING','BUILD_SUCCEEDED','Immutable provider build completed',$2::jsonb)`,
            [payload.deploymentId, JSON.stringify({ providerDeploymentId: build.provider_deployment_id, providerStatus, sourceCommitSha: build.source_commit_sha, sourceIdentityMatches })],
          );
        } else if (terminalFailure) {
          const failed = await db.query(`UPDATE deployments SET status='FAILED', error_code='BUILD_FAILED', error_message='Application build failed at the deployment provider.', finished_at=now(), updated_at=now() WHERE id=$1 AND status='BUILDING' RETURNING id`, [payload.deploymentId]);
          if (failed.rowCount === 1) await db.query(
            `INSERT INTO deployment_events (deployment_id,from_status,to_status,event_type,message,metadata)
             VALUES ($1,'BUILDING','FAILED','BUILD_FAILED','Provider build failed',$2::jsonb)`,
            [payload.deploymentId, JSON.stringify({ providerDeploymentId: build.provider_deployment_id, providerStatus, sourceCommitSha: build.source_commit_sha, sourceIdentityMatches })],
          );
        }
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }

      return {
        result: terminalSuccess ? "NODE_04_10_BUILD_VERIFIED" : terminalFailure ? "NODE_04_10_BUILD_FAILED" : "NODE_04_10_BUILD_PENDING",
        deploymentId: payload.deploymentId,
        providerDeploymentId: build.provider_deployment_id,
        providerDeploymentUrl: provider?.url ? `https://${provider.url}` : build.provider_deployment_url,
        providerStatus,
        expectedCommitSha: build.source_commit_sha,
        observedCommitSha: observedSha,
        sourceIdentityMatches: observedSha ? sourceIdentityMatches : null,
        nextDeploymentStatus: terminalSuccess ? "DEPLOYING" : terminalFailure ? "FAILED" : build.deployment_status,
      };
    } finally {
      await db.end();
    }
  },
});
