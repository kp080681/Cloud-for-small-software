import { task } from "@trigger.dev/sdk";
import pg from "pg";
import {
  classifyVercelDeploymentResource,
  duplicateSscDeploymentIdentities,
  summarizeClassifications,
} from "../src/orphan-resource-classification.mjs";

const { Client } = pg;
const API = "https://api.vercel.com";

function teamQuery(extra: Record<string, string> = {}) {
  const query = new URLSearchParams(extra);
  if (process.env.VERCEL_TEAM_ID) query.set("teamId", process.env.VERCEL_TEAM_ID);
  const text = query.toString();
  return text ? `?${text}` : "";
}

async function vercelRequest(path: string) {
  if (!process.env.VERCEL_TOKEN) throw new Error("Missing VERCEL_TOKEN");
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
  });
  const text = await response.text();
  let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { body = null; } }
  if (!response.ok) throw new Error(`Vercel API ${response.status} ${response.statusText}`);
  return body;
}

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

function runtimeProviderProjectIds(runtimes: any[]) {
  return [...new Set(runtimes.map((runtime) => runtime.provider_project_id).filter(Boolean))];
}

async function listProjectDeployments(projectId: string) {
  const body = await vercelRequest(`/v7/deployments${teamQuery({ projectId, limit: "100" })}`);
  const deployments = Array.isArray(body?.deployments) ? body.deployments : [];
  const detailed = [];
  for (const item of deployments) {
    const id = item?.uid ?? item?.id;
    if (!id) continue;
    const detail = await vercelRequest(`/v13/deployments/${encodeURIComponent(id)}${teamQuery()}`);
    detailed.push({
      provider: "vercel",
      providerProjectId: projectId,
      providerDeploymentId: detail?.id ?? detail?.uid ?? id,
      providerDeploymentUrl: detail?.url ? `https://${detail.url}` : null,
      readyState: detail?.readyState ?? detail?.status ?? null,
      target: detail?.target ?? null,
      meta: detail?.meta && typeof detail.meta === "object" ? detail.meta : {},
    });
  }
  return detailed;
}

export const detectOrphanResources = task({
  id: "ssc-control-plane-detect-orphan-resources",
  retry: { maxAttempts: 1 },
  run: async () => {
    return await withDb(async (db) => {
      const runtimeResult = await db.query(
        `SELECT app_id, provider, provider_project_id, provider_project_name, status
           FROM app_runtimes
          WHERE provider = 'vercel'
          ORDER BY created_at ASC`,
      );
      const runtimes = runtimeResult.rows;
      const projectIds = runtimeProviderProjectIds(runtimes);

      const deploymentResult = await db.query(`SELECT id, app_id, source_commit_sha, status FROM deployments`);
      const buildResult = await db.query(`SELECT deployment_id, provider, provider_deployment_id, source_commit_sha, status FROM deployment_builds WHERE provider='vercel'`);
      const operationResult = await db.query(`SELECT deployment_id, operation_type, provider, provider_resource_id, source_commit_sha, status FROM deployment_provider_operations WHERE provider='vercel'`);

      const controlPlane = {
        deploymentsById: new Map(deploymentResult.rows.map((row) => [row.id, {
          id: row.id,
          appId: row.app_id,
          sourceCommitSha: row.source_commit_sha,
          status: row.status,
        }])),
        buildsByDeploymentId: new Map(buildResult.rows.map((row) => [row.deployment_id, {
          deploymentId: row.deployment_id,
          providerDeploymentId: row.provider_deployment_id,
          sourceCommitSha: row.source_commit_sha,
          status: row.status,
        }])),
        buildsByProviderDeploymentId: new Map(buildResult.rows.map((row) => [row.provider_deployment_id, {
          deploymentId: row.deployment_id,
          providerDeploymentId: row.provider_deployment_id,
          sourceCommitSha: row.source_commit_sha,
          status: row.status,
        }])),
        operationsByProviderResourceId: new Map(operationResult.rows
          .filter((row) => row.provider_resource_id)
          .map((row) => [row.provider_resource_id, {
            deploymentId: row.deployment_id,
            operationType: row.operation_type,
            providerResourceId: row.provider_resource_id,
            sourceCommitSha: row.source_commit_sha,
            status: row.status,
          }])),
      };

      const providerDeployments = [];
      for (const projectId of projectIds) {
        providerDeployments.push(...await listProjectDeployments(projectId));
      }

      const ambiguousIdentities = duplicateSscDeploymentIdentities(providerDeployments);
      const classifications = providerDeployments.map((resource) => ({
        provider: "vercel",
        resourceType: "deployment",
        providerProjectId: resource.providerProjectId,
        providerDeploymentId: resource.providerDeploymentId,
        providerDeploymentUrl: resource.providerDeploymentUrl,
        readyState: resource.readyState,
        target: resource.target,
        ...classifyVercelDeploymentResource(resource, controlPlane, { ambiguousIdentities }),
      }));

      const actionable = classifications.filter((item) => ["RECOVERABLE", "ORPHAN", "AMBIGUOUS"].includes(item.classification));

      return {
        result: "NODE_04_19_ORPHAN_RESOURCE_DETECTION_COMPLETE",
        provider: "vercel",
        runtimeCount: runtimes.length,
        providerProjectCount: projectIds.length,
        providerDeploymentCount: providerDeployments.length,
        counts: summarizeClassifications(classifications),
        actionableCount: actionable.length,
        actionable,
        destructiveOperationExecuted: false,
        providerResourcesMutated: false,
        providerResponseBodiesReturned: false,
        tokensPrinted: false,
        secretsPrinted: false,
      };
    });
  },
});
