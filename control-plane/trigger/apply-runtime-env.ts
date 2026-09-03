import { task } from "@trigger.dev/sdk";
import pg from "pg";
import { decryptAppSecret } from "../src/secret-store.mjs";
import {
  assertRuntimeMatchesDeployment,
  assertSecretBindingBelongsToApp,
} from "../src/tenant-boundary.mjs";

const { Client } = pg;
const API = "https://api.vercel.com";

function teamQuery(extra: Record<string, string> = {}) {
  const query = new URLSearchParams(extra);
  if (process.env.VERCEL_TEAM_ID) query.set("teamId", process.env.VERCEL_TEAM_ID);
  const text = query.toString();
  return text ? `?${text}` : "";
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

export const applyRuntimeEnv = task({
  id: "ssc-control-plane-apply-runtime-env",
  retry: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 10000, factor: 2, randomize: false },
  run: async (payload: { deploymentId: string }) => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();

    try {
      const deploymentResult = await db.query(
        `SELECT d.id, d.workspace_id, d.app_id, d.status, d.runtime_project_id,
                r.provider, r.provider_project_id
           FROM deployments d
           JOIN app_runtimes r ON r.app_id = d.app_id
          WHERE d.id = $1`,
        [payload.deploymentId],
      );
      if (deploymentResult.rowCount === 0) throw new Error(`Deployment/runtime not found: ${payload.deploymentId}`);
      const deployment = deploymentResult.rows[0];
      if (deployment.status !== "BUILDING") throw new Error(`Runtime env can only be applied from BUILDING; current status is ${deployment.status}`);
      if (deployment.provider !== "vercel") throw new Error(`Unsupported runtime provider: ${deployment.provider}`);
      if (deployment.runtime_project_id !== deployment.provider_project_id) throw new Error("Runtime project binding mismatch");
      assertRuntimeMatchesDeployment({
        app_id: deployment.app_id,
        workspace_id: deployment.workspace_id,
        provider_project_id: deployment.provider_project_id,
      }, deployment);

      const bindingResult = await db.query(
        `SELECT b.id AS binding_id, b.workspace_id AS binding_workspace_id,
                b.app_id AS binding_app_id, b.env_key, b.target_environment,
                s.id AS secret_id, s.workspace_id AS secret_workspace_id,
                s.app_id AS secret_app_id, s.name AS secret_name,
                s.updated_at AS secret_updated_at
           FROM app_secret_bindings b
           JOIN encrypted_secrets s
             ON s.id = b.secret_id
            AND s.workspace_id = b.workspace_id
            AND s.app_id = b.app_id
          WHERE b.app_id = $1
            AND b.target_environment = 'production'
          ORDER BY b.env_key`,
        [deployment.app_id],
      );

      const requirementResult = await db.query(
        `SELECT env_key FROM app_env_requirements WHERE app_id=$1 AND required=true ORDER BY env_key`,
        [deployment.app_id],
      );
      const requiredKeys = requirementResult.rows.map((row) => row.env_key);
      const boundKeys = new Set(bindingResult.rows.map((row) => row.env_key));
      const missing = requiredKeys.filter((key) => !boundKeys.has(key));
      if (missing.length) throw new Error(`Required runtime variables are not configured: ${missing.join(", ")}`);

      // Runtime env application remains a BUILDING-stage backstop; Node 04.17
      // verifies required configuration earlier while the deployment is ANALYZING.
      const providerTargets = ["preview", "production"];
      const applied: Array<{ envKey: string; providerEnvId: string | null }> = [];
      for (const binding of bindingResult.rows) {
        assertSecretBindingBelongsToApp(binding, {
          id: deployment.app_id,
          workspace_id: deployment.workspace_id,
        });
        const plaintext = await decryptAppSecret(db, {
          appId: deployment.app_id,
          name: binding.secret_name,
        });

        let response: any;
        try {
          response = await vercelRequest(
            `/v10/projects/${encodeURIComponent(deployment.provider_project_id)}/env${teamQuery({ upsert: "true" })}`,
            {
              method: "POST",
              body: JSON.stringify({
                key: binding.env_key,
                value: plaintext,
                type: "sensitive",
                target: providerTargets,
                comment: "Managed by Small Software Cloud",
              }),
            },
          );
        } finally {
          // plaintext is intentionally never logged or persisted by this worker.
        }

        const providerEnvId = Array.isArray(response) ? (response[0]?.id ?? null) : (response?.id ?? response?.created?.id ?? null);
        await db.query(
          `INSERT INTO deployment_secret_applications
             (deployment_id, binding_id, secret_updated_at, provider_env_id, applied_at)
           VALUES ($1,$2,$3,$4,now())
           ON CONFLICT (deployment_id, binding_id) DO UPDATE SET
             secret_updated_at = EXCLUDED.secret_updated_at,
             provider_env_id = COALESCE(EXCLUDED.provider_env_id, deployment_secret_applications.provider_env_id),
             applied_at = now()`,
          [payload.deploymentId, binding.binding_id, binding.secret_updated_at, providerEnvId],
        );
        applied.push({ envKey: binding.env_key, providerEnvId });
      }

      await db.query(
        `INSERT INTO deployment_events
           (deployment_id, from_status, to_status, event_type, message, metadata)
         VALUES ($1,'BUILDING','BUILDING','RUNTIME_ENV_APPLIED',
                 'Runtime environment variables reconciled', $2::jsonb)`,
        [payload.deploymentId, JSON.stringify({
          provider: "vercel",
          providerProjectId: deployment.provider_project_id,
          appliedKeys: applied.map((item) => item.envKey),
          appliedCount: applied.length,
          providerTargets,
          plaintextPrinted: false,
          plaintextPersisted: false,
        })],
      );

      return {
        result: "NODE_04_9_RUNTIME_ENV_APPLIED",
        deploymentId: payload.deploymentId,
        provider: "vercel",
        providerProjectId: deployment.provider_project_id,
        appliedCount: applied.length,
        appliedKeys: applied.map((item) => item.envKey),
        providerTargets,
        providerEnvIdsPresent: applied.filter((item) => item.providerEnvId).length,
        deploymentStatus: deployment.status,
        plaintextPrinted: false,
        plaintextPersisted: false,
      };
    } finally {
      await db.end();
    }
  },
});
