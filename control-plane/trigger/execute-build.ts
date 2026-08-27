import { task } from "@trigger.dev/sdk";
import pg from "pg";

const { Client } = pg;
const API = "https://api.vercel.com";

function teamQuery() {
  const teamId = process.env.VERCEL_TEAM_ID;
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
}

function safeProviderErrorBody(body: any) {
  if (!body || typeof body !== "object") return null;
  const error = body.error && typeof body.error === "object" ? body.error : null;
  return {
    error: error ? { code: error.code ?? null, message: error.message ?? null } : null,
    code: body.code ?? null,
    message: body.message ?? null,
  };
}

async function vercelRequest(path: string, options: RequestInit = {}) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("Missing VERCEL_TOKEN");
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { body = null; } }
  if (!response.ok) {
    const safe = safeProviderErrorBody(body);
    throw new Error(`Vercel API ${response.status} ${response.statusText}${safe ? `: ${JSON.stringify(safe)}` : ""}`);
  }
  return body;
}

export const executeBuild = task({
  id: "ssc-control-plane-execute-build",
  retry: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 10000, factor: 2, randomize: false },
  run: async (payload: { deploymentId: string }) => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();

    try {
      const existing = await db.query(
        `SELECT provider, provider_deployment_id, provider_deployment_url, source_commit_sha, status
           FROM deployment_builds
          WHERE deployment_id = $1`,
        [payload.deploymentId],
      );
      if (existing.rowCount === 1) {
        const build = existing.rows[0];
        return {
          result: "NODE_04_10_REPLAY_NOOP",
          deploymentId: payload.deploymentId,
          provider: build.provider,
          providerDeploymentId: build.provider_deployment_id,
          providerDeploymentUrl: build.provider_deployment_url,
          sourceCommitSha: build.source_commit_sha,
          buildStatus: build.status,
        };
      }

      const result = await db.query(
        `SELECT d.id, d.status, d.runtime_project_id,
                a.framework,
                rt.provider, rt.provider_project_id, rt.provider_project_name,
                bi.repository_full_name, bi.commit_sha, bi.root_directory,
                bi.install_command, bi.build_command, bi.manifest_sha256
           FROM deployments d
           JOIN apps a ON a.id = d.app_id
           JOIN app_runtimes rt ON rt.app_id = d.app_id
           JOIN deployment_build_inputs bi ON bi.deployment_id = d.id
          WHERE d.id = $1`,
        [payload.deploymentId],
      );
      if (result.rowCount === 0) throw new Error(`Build prerequisites not found: ${payload.deploymentId}`);
      const deployment = result.rows[0];
      if (deployment.status !== "BUILDING") throw new Error(`Build can only execute from BUILDING; current status is ${deployment.status}`);
      if (deployment.provider !== "vercel") throw new Error(`Unsupported build provider: ${deployment.provider}`);
      if (deployment.runtime_project_id !== deployment.provider_project_id) throw new Error("Runtime project binding mismatch");

      const [org, repo] = String(deployment.repository_full_name).split("/");
      if (!org || !repo) throw new Error(`Invalid GitHub repository identity: ${deployment.repository_full_name}`);

      const body: any = {
        name: deployment.provider_project_name,
        project: deployment.provider_project_id,
        gitSource: {
          type: "github",
          org,
          repo,
          ref: deployment.commit_sha,
        },
        meta: {
          sscDeploymentId: payload.deploymentId,
          sscManifestSha256: deployment.manifest_sha256,
          sscSourceCommitSha: deployment.commit_sha,
        },
        projectSettings: {
          framework: deployment.framework || "nextjs",
          installCommand: deployment.install_command,
          buildCommand: deployment.build_command,
        },
      };

      const created = await vercelRequest(`/v13/deployments${teamQuery()}`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      const providerDeploymentId = created?.id;
      if (!providerDeploymentId) throw new Error("Vercel deployment creation returned no deployment id");
      const providerDeploymentUrl = created?.url ? `https://${created.url}` : null;
      const providerStatus = created?.readyState ?? created?.status ?? "QUEUED";

      await db.query("BEGIN");
      try {
        await db.query(
          `INSERT INTO deployment_builds
             (deployment_id, provider, provider_deployment_id, provider_deployment_url, source_commit_sha, status)
           VALUES ($1,'vercel',$2,$3,$4,$5)`,
          [payload.deploymentId, providerDeploymentId, providerDeploymentUrl, deployment.commit_sha, providerStatus],
        );
        await db.query(
          `UPDATE deployments
              SET provider_deployment_id=$1,
                  updated_at=now()
            WHERE id=$2 AND status='BUILDING'`,
          [providerDeploymentId, payload.deploymentId],
        );
        await db.query(
          `INSERT INTO deployment_events
             (deployment_id, from_status, to_status, event_type, message, metadata)
           VALUES ($1,'BUILDING','BUILDING','BUILD_STARTED',
                   'Immutable provider build started', $2::jsonb)`,
          [payload.deploymentId, JSON.stringify({
            provider: "vercel",
            providerDeploymentId,
            providerDeploymentUrl,
            sourceCommitSha: deployment.commit_sha,
            manifestSha256: deployment.manifest_sha256,
            providerStatus,
          })],
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }

      return {
        result: "NODE_04_10_BUILD_STARTED",
        deploymentId: payload.deploymentId,
        provider: "vercel",
        providerProjectId: deployment.provider_project_id,
        providerDeploymentId,
        providerDeploymentUrl,
        sourceCommitSha: deployment.commit_sha,
        manifestSha256: deployment.manifest_sha256,
        buildStatus: providerStatus,
        target: "preview",
      };
    } finally {
      await db.end();
    }
  },
});
