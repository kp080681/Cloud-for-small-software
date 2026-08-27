import { task } from "@trigger.dev/sdk";
import pg from "pg";

const { Client } = pg;
const API = "https://api.vercel.com";

async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try { return await fn(db); } finally { await db.end(); }
}

function teamQuery() {
  const teamId = process.env.VERCEL_TEAM_ID;
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
}

async function request(path: string, options: RequestInit = {}) {
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
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (!response.ok) {
    const error: any = new Error(`Vercel API ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function getRuntime(name: string) {
  try { return await request(`/v9/projects/${encodeURIComponent(name)}${teamQuery()}`); }
  catch (error: any) { if (error.status === 404) return null; throw error; }
}

async function ensureRuntime({ name, repository, rootDirectory }: { name: string; repository: string; rootDirectory: string }) {
  const existing = await getRuntime(name);
  if (existing) return { resource: existing, created: false, reconciled: true };
  try {
    const created = await request(`/v11/projects${teamQuery()}`, {
      method: "POST",
      body: JSON.stringify({
        name,
        framework: "nextjs",
        rootDirectory,
        gitRepository: { type: "github", repo: repository },
      }),
    });
    return { resource: created, created: true, reconciled: false };
  } catch (error: any) {
    if ([400, 409].includes(error.status)) {
      const reconciled = await getRuntime(name);
      if (reconciled) return { resource: reconciled, created: false, reconciled: true };
    }
    throw error;
  }
}

export const provisionRuntime = task({
  id: "ssc-control-plane-provision-runtime",
  retry: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 10000, factor: 2, randomize: false },
  run: async (payload: { deploymentId: string }) => {
    return await withDb(async (db) => {
      const result = await db.query(
        `SELECT d.id, d.workspace_id, d.app_id, d.status,
                a.slug, a.root_directory,
                r.full_name AS repository_full_name
           FROM deployments d
           JOIN apps a ON a.id = d.app_id
           JOIN github_repositories r ON r.id = a.repository_id
          WHERE d.id = $1`,
        [payload.deploymentId],
      );
      if (result.rowCount === 0) throw new Error(`Deployment not found: ${payload.deploymentId}`);
      const deployment = result.rows[0];
      if (deployment.status !== "PROVISIONING" && deployment.status !== "BUILDING") {
        throw new Error(`Runtime cannot be provisioned from status ${deployment.status}`);
      }

      const existingRuntime = await db.query(
        `SELECT provider, provider_project_id, provider_project_name, reconciliation_key, status
           FROM app_runtimes WHERE app_id = $1`,
        [deployment.app_id],
      );
      if (existingRuntime.rowCount === 1) {
        const runtime = existingRuntime.rows[0];
        return {
          result: "NODE_04_8_REPLAY_NOOP",
          deploymentId: payload.deploymentId,
          status: deployment.status,
          provider: runtime.provider,
          providerProjectId: runtime.provider_project_id,
          providerProjectName: runtime.provider_project_name,
          reconciliationKey: runtime.reconciliation_key,
          runtimeStatus: runtime.status,
        };
      }

      const projectName = `ssc-${deployment.slug}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80);
      const reconciliationKey = `runtime:${deployment.workspace_id}:${deployment.app_id}`;
      const provisioned = await ensureRuntime({
        name: projectName,
        repository: deployment.repository_full_name,
        rootDirectory: deployment.root_directory,
      });
      const project = provisioned.resource;
      if (!project?.id) throw new Error("Vercel runtime creation returned no project id");

      await db.query("BEGIN");
      try {
        await db.query(
          `INSERT INTO app_runtimes
             (workspace_id, app_id, provider, provider_project_id, provider_project_name,
              reconciliation_key, status)
           VALUES ($1,$2,'vercel',$3,$4,$5,'READY')`,
          [deployment.workspace_id, deployment.app_id, project.id, project.name ?? projectName, reconciliationKey],
        );

        await db.query(
          `UPDATE deployments
              SET runtime_project_id = $1,
                  status = 'BUILDING',
                  updated_at = now()
            WHERE id = $2 AND status = 'PROVISIONING'`,
          [project.id, payload.deploymentId],
        );

        await db.query(
          `INSERT INTO deployment_events
             (deployment_id, from_status, to_status, event_type, message, metadata)
           VALUES ($1, 'PROVISIONING', 'BUILDING', 'RUNTIME_PROVISIONED',
                   'Application runtime provisioned or reconciled', $2::jsonb)`,
          [payload.deploymentId, JSON.stringify({
            provider: "vercel",
            providerProjectId: project.id,
            providerProjectName: project.name ?? projectName,
            reconciliationKey,
            created: provisioned.created,
            reconciled: provisioned.reconciled,
          })],
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }

      return {
        result: "NODE_04_8_RUNTIME_PROVISIONED",
        deploymentId: payload.deploymentId,
        status: "BUILDING",
        provider: "vercel",
        providerProjectId: project.id,
        providerProjectName: project.name ?? projectName,
        reconciliationKey,
        created: provisioned.created,
        reconciled: provisioned.reconciled,
      };
    });
  },
});
