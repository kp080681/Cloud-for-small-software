import { getAuthorizedWorkspace, listWorkspaceApplications } from "./customer-workspaces.mjs";
import { analyzeSelectedRepository } from "./repository-analysis.mjs";
import { listWorkspaceInstallationRepositories, selectWorkspaceRepository } from "./customer-github.mjs";
import { startCustomerDeployment, getCustomerDeploymentProgressWithResume } from "./customer-deployments.mjs";
import { getDeploymentReadiness, saveCustomerAppSecret } from "./customer-configuration.mjs";

// Implements the five tools locked in mcp/schemas/*.json (checklist item 7),
// composed entirely from existing, already-tested customer-interface
// functions — no new deployment logic, no new tenant-boundary logic.
// deploy() is the one genuinely new composition (item 9's flagged gap):
// today analyze-for-a-new-app and redeploy-an-existing-app are two separate
// functions with nothing that picks between them; this is that missing
// entry point.

export class McpToolError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.status = status;
  }
}

async function findSelectedRepositoryId(db, { workspaceId, repo }) {
  const result = await db.query(
    `SELECT id FROM github_repositories WHERE workspace_id = $1 AND lower(full_name) = lower($2) LIMIT 1`,
    [workspaceId, repo],
  );
  return result.rows[0]?.id ?? null;
}

// Resolves a "owner/repo" string to our internal github_repositories.id,
// selecting it first (via the real GitHub-backed selection flow) if this
// workspace has never selected it before. Reuses selectWorkspaceRepository
// exactly as the web UI's repo picker does — no parallel selection logic.
async function resolveAndSelectRepository(db, { customerId, workspaceId, repo, listRepositories }) {
  const existing = await findSelectedRepositoryId(db, { workspaceId, repo });
  if (existing) return existing;

  const listing = await listWorkspaceInstallationRepositories(db, { customerId, workspaceId, listRepositories });
  for (const group of listing.installations) {
    const match = (group.repositories || []).find((r) => r.fullName?.toLowerCase() === repo.toLowerCase());
    if (match) {
      const selected = await selectWorkspaceRepository(db, {
        customerId,
        workspaceId,
        installationId: group.installation.githubInstallationId,
        repositoryId: match.githubRepositoryId,
        listRepositories,
      });
      return selected.id;
    }
  }
  throw new McpToolError(
    "REPOSITORY_NOT_AVAILABLE",
    `"${repo}" isn't available to this workspace's connected GitHub installation.`,
    404,
  );
}

function missingConfigFrom(requirements = []) {
  return requirements
    .filter((item) => item.required && !item.managed && !item.configured)
    .map((item) => ({ key: item.envKey, public: Boolean(item.public) }));
}

// deploy — always deploys the repository's current code. Composed from
// analyzeSelectedRepository alone (no redeployLiveCustomerApp branch) —
// an independent review (Opus 5.5) found the original design used
// redeployLiveCustomerApp for an app's second-and-later deploy calls, but
// that function rebuilds app.live_source_commit_sha (the commit that is
// already live), never fetching the repository's current HEAD. An agent
// pushing a fix and calling deploy would get "queued" back and could tell
// the user their change was live when the platform had just rebuilt the
// old code. redeployLiveCustomerApp's actual purpose — rebuilding the
// exact same commit, e.g. after a transient build failure — is a
// recovery action, not what a tool literally named "deploy" should mean;
// analyzeSelectedRepository's own createOrReuseApp/createOrReuseDeployment
// already correctly reuse the existing app and idempotently reuse-or-create
// the deployment row for whatever commit is actually at HEAD right now,
// which is the behavior this tool's name promises.
export async function deploy(
  db,
  {
    customerId,
    workspaceId,
    repo,
    branch,
    listRepositories,
    createInstallationClient,
    deploymentKeyFactory,
    authorizeWorkspace = getAuthorizedWorkspace,
    analyzeRepository = analyzeSelectedRepository,
    checkReadiness = getDeploymentReadiness,
    startDeployment = startCustomerDeployment,
  },
) {
  await authorizeWorkspace(db, { customerId, workspaceId });

  // branch is accepted by the schema for a future non-default-branch deploy,
  // but analyzeSelectedRepository always analyzes the repository's own
  // default branch today — there is no per-deploy branch override in the
  // underlying pipeline yet. Silently ignoring an explicit non-default
  // branch would be misleading, so it's rejected outright rather than
  // pretending to honor it.
  if (branch) {
    throw new McpToolError(
      "BRANCH_OVERRIDE_NOT_SUPPORTED",
      "Deploying a specific branch isn't supported yet — omit branch to deploy the repository's default branch.",
      400,
    );
  }

  const repositoryId = await resolveAndSelectRepository(db, { customerId, workspaceId, repo, listRepositories });
  const analysis = await analyzeRepository(db, {
    customerId,
    workspaceId,
    repositoryId,
    createInstallationClient,
    deploymentKeyFactory,
  });

  if (!analysis.supported) {
    return {
      appId: analysis.appId,
      deploymentId: analysis.deploymentId,
      status: "blocked",
      message: analysis.errorCode ? `This repository isn't supported: ${analysis.errorCode}` : "This repository isn't supported.",
      url: null,
    };
  }

  const readiness = await checkReadiness(db, { customerId, workspaceId, appId: analysis.appId });

  if (readiness.readiness === "READY_TO_DEPLOY") {
    // Safe even if this exact commit is already live: startCustomerDeployment
    // recognizes an already-LIVE deployment and treats the call as a no-op
    // success (alreadyStarted) rather than re-triggering anything.
    await startDeployment(db, {
      customerId,
      workspaceId,
      appId: analysis.appId,
      deploymentId: readiness.deploymentId,
    });
    return {
      appId: analysis.appId,
      deploymentId: readiness.deploymentId,
      status: "queued",
      message: "Deploying — this'll take a moment.",
      url: null,
    };
  }

  if (readiness.readiness === "BLOCKED") {
    return {
      appId: analysis.appId,
      deploymentId: readiness.deploymentId,
      status: "blocked",
      message: "This app can't be deployed right now — check get_status for details.",
      url: null,
    };
  }

  return {
    appId: analysis.appId,
    deploymentId: readiness.deploymentId,
    status: "needs_configuration",
    missingConfig: missingConfigFrom(readiness.requirements),
    message: "This app needs some configuration before it can deploy.",
    url: null,
  };
}

async function loadLatestDeploymentId(db, { appId }) {
  const result = await db.query(`SELECT id FROM deployments WHERE app_id = $1 ORDER BY created_at DESC LIMIT 1`, [appId]);
  return result.rows[0]?.id ?? null;
}

// get_status — deliberately calls the WithResume variant, not the plain
// progress lookup: this is what connects item 6's self-healing work
// directly to the MCP surface. If the deployment silently stalled and is
// eligible for the same auto-resume a human checking the dashboard would
// trigger, an agent calling get_status gets that resume for free rather
// than needing a separate "did it get stuck" check.
export async function getStatus(
  db,
  { customerId, workspaceId, appId, authorizeWorkspace = getAuthorizedWorkspace, loadProgress = getCustomerDeploymentProgressWithResume },
) {
  await authorizeWorkspace(db, { customerId, workspaceId });
  const deploymentId = await loadLatestDeploymentId(db, { appId });
  if (!deploymentId) throw new McpToolError("APPLICATION_NOT_FOUND", "This app has no deployments yet.", 404);

  const progress = await loadProgress(db, { customerId, workspaceId, appId, deploymentId });
  return {
    status: progress.status,
    stage: progress.stage,
    active: progress.active,
    terminal: progress.terminal,
    url: progress.liveUrl ?? null,
    message: progress.diagnostic?.title || (progress.terminal ? "This deployment has finished." : "This deployment is in progress."),
    diagnostic: progress.diagnostic ?? null,
  };
}

export async function getLogs(
  db,
  { customerId, workspaceId, appId, limit = 10, authorizeWorkspace = getAuthorizedWorkspace, loadProgress = getCustomerDeploymentProgressWithResume },
) {
  await authorizeWorkspace(db, { customerId, workspaceId });
  const deploymentId = await loadLatestDeploymentId(db, { appId });
  if (!deploymentId) throw new McpToolError("APPLICATION_NOT_FOUND", "This app has no deployments yet.", 404);

  const progress = await loadProgress(db, { customerId, workspaceId, appId, deploymentId });
  const events = Array.isArray(progress.events) ? progress.events : [];
  const entries = events.slice(-limit).map((event) => ({ at: event.at, title: event.title, evidence: event.evidence }));
  return {
    summary: progress.diagnostic?.title || `Status: ${progress.stage}.`,
    entries,
  };
}

export async function setEnv(db, { customerId, workspaceId, appId, key, value, saveSecret = saveCustomerAppSecret }) {
  const result = await saveSecret(db, { customerId, workspaceId, appId, envKey: key, plaintext: value });
  return {
    configured: Boolean(result.configured),
    message: `${result.envKey} saved.`,
  };
}

export async function listApps(db, { customerId, workspaceId, loadApplications = listWorkspaceApplications }) {
  const apps = await loadApplications(db, { customerId, workspaceId });
  return {
    apps: apps.map((app) => ({
      appId: app.id,
      name: app.name,
      slug: app.slug,
      status: app.latestDeploymentStatus ?? null,
      url: app.liveUrl ?? null,
    })),
  };
}
