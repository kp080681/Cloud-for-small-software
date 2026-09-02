import crypto from "node:crypto";
import pg from "pg";
import {
  RECOVERY_TEST_APP_ID,
  RECOVERY_TEST_PROVIDER_PROJECT_ID,
  assertRecoveryTestRuntime,
  isNode0419OrphanFixtureResource,
  node0419OrphanFixtureMeta,
} from "../src/orphan-fixture-guard.mjs";
import { gitAutoDeploymentsDisabled } from "../src/vercel-project-config.mjs";

const { Client } = pg;
const API = "https://api.vercel.com";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");
if (!process.env.VERCEL_TOKEN) throw new Error("Missing required environment variable: VERCEL_TOKEN");

function teamQuery(extra = {}) {
  const query = new URLSearchParams(extra);
  if (process.env.VERCEL_TEAM_ID) query.set("teamId", process.env.VERCEL_TEAM_ID);
  const text = query.toString();
  return text ? `?${text}` : "";
}

function safeProviderErrorBody(body) {
  if (!body || typeof body !== "object") return null;
  const error = body.error && typeof body.error === "object" ? body.error : null;
  return {
    error: error ? { code: error.code ?? null, message: error.message ?? null } : null,
    code: body.code ?? null,
    message: body.message ?? null,
  };
}

async function vercelRequest(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (!response.ok) {
    const safe = safeProviderErrorBody(body);
    throw new Error(`Vercel API ${response.status} ${response.statusText}${safe ? `: ${JSON.stringify(safe)}` : ""}`);
  }
  return body;
}

async function readRecoveryTestRuntime(db) {
  const result = await db.query(
    `SELECT a.id AS app_id,
            a.workspace_id,
            a.name AS app_name,
            a.slug,
            a.framework,
            a.root_directory,
            gr.full_name AS repository_full_name,
            rt.provider,
            rt.provider_project_id,
            rt.provider_project_name,
            rt.status AS runtime_status
       FROM apps a
       JOIN github_repositories gr ON gr.id = a.repository_id
       JOIN app_runtimes rt ON rt.app_id = a.id
      WHERE a.id = $1
        AND rt.provider = 'vercel'`,
    [RECOVERY_TEST_APP_ID],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Disposable recovery-test app/runtime not found: ${RECOVERY_TEST_APP_ID}`);
  }
  const runtime = result.rows[0];
  assertRecoveryTestRuntime({
    appId: runtime.app_id,
    providerProjectId: runtime.provider_project_id,
  });
  return runtime;
}

async function readLatestBuildInput(db) {
  const result = await db.query(
    `SELECT d.source_commit_sha,
            bi.repository_full_name,
            bi.commit_sha,
            bi.root_directory,
            bi.install_command,
            bi.build_command,
            bi.manifest_sha256
       FROM deployments d
       JOIN deployment_build_inputs bi ON bi.deployment_id = d.id
      WHERE d.app_id = $1
      ORDER BY d.created_at DESC
      LIMIT 1`,
    [RECOVERY_TEST_APP_ID],
  );
  if (result.rowCount !== 1) {
    throw new Error("Disposable recovery-test app has no immutable build input to reuse for fixture source identity");
  }
  const buildInput = result.rows[0];
  if (buildInput.commit_sha !== buildInput.source_commit_sha) {
    throw new Error("Latest build input commit does not match deployment source identity");
  }
  return buildInput;
}

async function newUnboundDeploymentId(db) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const deploymentId = crypto.randomUUID();
    const result = await db.query(`SELECT 1 FROM deployments WHERE id = $1`, [deploymentId]);
    if (result.rowCount === 0) return deploymentId;
  }
  throw new Error("Could not generate an unbound fixture deployment id");
}

async function listDetailedProjectDeployments(projectId) {
  const body = await vercelRequest(`/v7/deployments${teamQuery({ projectId, limit: "100" })}`);
  const deployments = Array.isArray(body?.deployments) ? body.deployments : [];
  const detailed = [];
  for (const item of deployments) {
    const id = item?.uid ?? item?.id;
    if (!id) continue;
    const detail = await vercelRequest(`/v13/deployments/${encodeURIComponent(id)}${teamQuery()}`);
    detailed.push({
      id: detail?.id ?? detail?.uid ?? id,
      url: detail?.url ?? null,
      meta: detail?.meta && typeof detail.meta === "object" ? detail.meta : {},
    });
  }
  return detailed;
}

async function verifyDisposableProviderProject(projectId) {
  const project = await vercelRequest(`/v9/projects/${encodeURIComponent(projectId)}${teamQuery()}`);
  if (project?.id !== RECOVERY_TEST_PROVIDER_PROJECT_ID) {
    throw new Error(`Vercel project identity mismatch for disposable fixture target: ${project?.id ?? "missing"}`);
  }
  if (!gitAutoDeploymentsDisabled(project)) {
    throw new Error("Refusing to create orphan fixture while Vercel Git automatic deployments are enabled");
  }
  return project;
}

function repositoryOwnerAndName(repositoryFullName) {
  const [org, repo] = String(repositoryFullName).split("/");
  if (!org || !repo) throw new Error(`Invalid GitHub repository identity: ${repositoryFullName}`);
  return { org, repo };
}

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  const runtime = await readRecoveryTestRuntime(db);
  const buildInput = await readLatestBuildInput(db);
  await verifyDisposableProviderProject(runtime.provider_project_id);
  const existingFixtures = (await listDetailedProjectDeployments(RECOVERY_TEST_PROVIDER_PROJECT_ID))
    .filter(isNode0419OrphanFixtureResource);

  if (existingFixtures.length > 0) {
    throw new Error(`Refusing to create a second Node 04.19 orphan fixture; existing provider deployment: ${existingFixtures[0].id}`);
  }

  const fixtureDeploymentId = await newUnboundDeploymentId(db);
  const { org, repo } = repositoryOwnerAndName(buildInput.repository_full_name);
  const meta = node0419OrphanFixtureMeta({
    deploymentId: fixtureDeploymentId,
    sourceCommitSha: buildInput.commit_sha,
    manifestSha256: buildInput.manifest_sha256,
    appId: runtime.app_id,
    providerProjectId: runtime.provider_project_id,
  });

  const created = await vercelRequest(`/v13/deployments${teamQuery()}`, {
    method: "POST",
    body: JSON.stringify({
      name: runtime.provider_project_name,
      project: runtime.provider_project_id,
      target: "preview",
      gitSource: {
        type: "github",
        org,
        repo,
        ref: buildInput.commit_sha,
      },
      meta,
      projectSettings: {
        framework: runtime.framework || "nextjs",
        installCommand: buildInput.install_command,
        buildCommand: buildInput.build_command,
      },
    }),
  });

  console.log(JSON.stringify({
    result: "NODE_04_19_DISPOSABLE_ORPHAN_FIXTURE_CREATED",
    appId: runtime.app_id,
    providerProjectId: runtime.provider_project_id,
    providerProjectName: runtime.provider_project_name,
    providerDeploymentId: created?.id ?? created?.uid ?? null,
    providerDeploymentUrl: created?.url ? `https://${created.url}` : null,
    target: "preview",
    fixtureSscDeploymentId: fixtureDeploymentId,
    sourceCommitSha: buildInput.commit_sha,
    metadataKeys: Object.keys(meta).sort(),
    controlPlaneDeploymentRowCreated: false,
    databaseRowsModified: false,
    providerResourcesDeleted: false,
    destructiveOperationExecuted: false,
    tokensPrinted: false,
    secretsPrinted: false,
  }, null, 2));
} finally {
  await db.end();
}
