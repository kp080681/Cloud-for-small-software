import { getAuthorizedWorkspace, listWorkspaceApplications } from "./customer-workspaces.mjs";
import { friendlyErrorMessage } from "../shared/deployment-ui-state.mjs";
import { analyzeSelectedRepository } from "./repository-analysis.mjs";
import { listWorkspaceInstallationRepositories, selectWorkspaceRepository } from "./customer-github.mjs";
import { startCustomerDeployment, getCustomerDeploymentProgressWithResume } from "./customer-deployments.mjs";
import { getDeploymentReadiness, saveCustomerAppSecret } from "./customer-configuration.mjs";
import { checkCustomDomain, connectCustomDomain, getAppCustomDomain } from "./customer-custom-domain.mjs";

// Implements the five tools locked in mcp/schemas/*.json (checklist item 7),
// composed entirely from existing, already-tested customer-interface
// functions — no new deployment logic, no new tenant-boundary logic.
// deploy() is the one genuinely new composition (item 9's flagged gap):
// today analyze-for-a-new-app and redeploy-an-existing-app are two separate
// functions with nothing that picks between them; this is that missing
// entry point.

const DASHBOARD = "https://app.utplava.dev";

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
async function resolveAndSelectRepository(db, { customerId, workspaceId, repo, listRepositories, listInstallations = listWorkspaceInstallationRepositories }) {
  const existing = await findSelectedRepositoryId(db, { workspaceId, repo });
  if (existing) return existing;

  const listing = await listInstallations(db, { customerId, workspaceId, listRepositories });
  // Newcomers (2026-10-29): someone who just added Utplava from an AI
  // assistant's directory usually hasn't shared any repositories yet. Say
  // exactly what to do, with the link, rather than a bare "not available".
  if (!listing.installations.length) {
    throw new McpToolError(
      "GITHUB_NOT_CONNECTED",
      `Utplava can't see your GitHub repositories yet. Open ${DASHBOARD}/new, click "Connect GitHub" and choose ${repo} (or all repositories). Then ask to deploy again.`,
      404,
    );
  }
  if (listing.installations.every((group) => group.error)) {
    throw new McpToolError(
      "GITHUB_ACCESS_NEEDS_RECONNECT",
      `Utplava lost access to your GitHub repositories. Open ${DASHBOARD}/new and click "Manage GitHub access" to reconnect, then ask to deploy again.`,
      404,
    );
  }
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
    `Utplava can't see "${repo}" yet. Open ${DASHBOARD}/new, click "Manage GitHub access" and add ${repo} to the repositories Utplava may use, then ask to deploy again. (Check the name is spelled exactly as on GitHub, as owner/name.)`,
    404,
  );
}

function needsConfigMessage(missing, appUrl) {
  const keys = missing.map((item) => item.key);
  const list = keys.length ? `: ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? "…" : ""}` : "";
  return `This app needs ${keys.length === 1 ? "a setting" : "some settings"} before it can go live${list}. They can be saved with set_env, or on the app's page: ${appUrl}`;
}

function missingConfigFrom(requirements = []) {
  return requirements
    .filter((item) => item.required && !item.managed && !item.configured)
    // Capped at 50 alongside the 64-char key-length cap in
    // env-requirement-detection.mjs — one further bound on the same
    // attacker-influenced text channel (a repo with many suggestively-
    // named short variables could otherwise still assemble a large
    // combined payload even with each individual name kept short).
    .slice(0, 50)
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
    listInstallations,
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

  const repositoryId = await resolveAndSelectRepository(db, { customerId, workspaceId, repo, listRepositories, listInstallations });
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
      errorCode: analysis.errorCode ?? null,
      message: friendlyErrorMessage(analysis.errorCode, "Utplava can't deploy this repository yet."),
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
      dashboardUrl: `${DASHBOARD}/apps/${analysis.appId}?workspace=${workspaceId}`,
      url: null,
    };
  }

  if (readiness.readiness === "BLOCKED") {
    return {
      appId: analysis.appId,
      deploymentId: readiness.deploymentId,
      status: "blocked",
      message: `This app can't be deployed right now. Its page in the dashboard explains why: ${DASHBOARD}/apps/${analysis.appId}?workspace=${workspaceId}`,
      url: null,
    };
  }

  return {
    appId: analysis.appId,
    deploymentId: readiness.deploymentId,
    status: "needs_configuration",
    missingConfig: missingConfigFrom(readiness.requirements),
    message: needsConfigMessage(missingConfigFrom(readiness.requirements), `${DASHBOARD}/apps/${analysis.appId}?workspace=${workspaceId}`),
    url: null,
  };
}

// Scoped to the caller's workspace, not just appId — closes an existence
// oracle an independent review (Opus 5.5) flagged: without the workspace
// filter, a nonexistent app id and another tenant's real app id could
// return distinguishably different results (the get_status/get_logs
// authorization check still holds independently, but this makes the data
// lookup itself refuse to answer for an app outside the caller's
// workspace too, rather than relying on that one earlier check alone).
async function loadLatestDeploymentId(db, { workspaceId, appId }) {
  const result = await db.query(
    `SELECT d.id FROM deployments d JOIN apps a ON a.id = d.app_id
      WHERE d.app_id = $1 AND a.workspace_id = $2 AND a.deleted_at IS NULL
      ORDER BY d.created_at DESC LIMIT 1`,
    [appId, workspaceId],
  );
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
  const deploymentId = await loadLatestDeploymentId(db, { workspaceId, appId });
  if (!deploymentId) throw new McpToolError("APPLICATION_NOT_FOUND", "This app has no deployments yet.", 404);

  const progress = await loadProgress(db, { customerId, workspaceId, appId, deploymentId });
  const customUrl = progress.status === "LIVE" && progress.liveUrl ? await activeCustomDomainUrl(db, appId) : null;
  return {
    status: progress.status,
    stage: progress.stage,
    active: progress.active,
    terminal: progress.terminal,
    url: customUrl ?? customerFacingUrl(progress.liveUrl),
    message: progress.diagnostic?.title
      || (progress.liveUrl && !customerFacingUrl(progress.liveUrl)
        ? "This app is live; its utplava.dev link is still being set up. Check again in a minute."
        : progress.terminal ? "This deployment has finished." : "This deployment is in progress."),
    diagnostic: progress.diagnostic ?? null,
  };
}

export async function getLogs(
  db,
  { customerId, workspaceId, appId, limit = 10, authorizeWorkspace = getAuthorizedWorkspace, loadProgress = getCustomerDeploymentProgressWithResume },
) {
  await authorizeWorkspace(db, { customerId, workspaceId });
  const deploymentId = await loadLatestDeploymentId(db, { workspaceId, appId });
  if (!deploymentId) throw new McpToolError("APPLICATION_NOT_FOUND", "This app has no deployments yet.", 404);

  const progress = await loadProgress(db, { customerId, workspaceId, appId, deploymentId });
  const events = Array.isArray(progress.events) ? progress.events : [];
  // Internal bookkeeping events have no customer meaning; leave them out.
  const meaningful = events.filter((event) => event.title && event.title !== "Deployment event recorded");
  const entries = meaningful.slice(-limit).map((event) => ({ at: event.at, title: event.title, evidence: event.evidence }));
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

// Agents relay links to people verbatim, so they only ever get the app's
// utplava.dev link. While that link is still being set up (the provider's
// own …vercel.app address is serving), they get null and a message saying so.
function customerFacingUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.endsWith(".vercel.app") ? null : url;
  } catch {
    return null;
  }
}

export async function listApps(db, { customerId, workspaceId, loadApplications = listWorkspaceApplications }) {
  const apps = await loadApplications(db, { customerId, workspaceId });
  return {
    ...(apps.length ? {} : {
      message: `No apps yet. To put one online, deploy a GitHub repository (owner/name). If Utplava can't see your repositories, connect GitHub first at ${DASHBOARD}/new.`,
    }),
    apps: apps.map((app) => ({
      appId: app.id,
      name: app.name,
      slug: app.slug,
      status: app.latestDeploymentStatus ?? null,
      url: customerFacingUrl(app.liveUrl),
    })),
  };
}

async function activeCustomDomainUrl(db, appId) {
  const result = await db.query(
    `SELECT domain FROM app_custom_domains WHERE app_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [appId],
  );
  return result.rows[0] ? `https://${result.rows[0].domain}` : null;
}

// connect_domain — connects the person's own domain to an app, or reports
// how far an already-connected one has got. Utplava attaches it in the
// background; the records to add usually appear within a few seconds, so
// this waits briefly for them rather than returning an empty list.
export async function connectDomain(
  db,
  { customerId, workspaceId, appId, domain, authorizeWorkspace = getAuthorizedWorkspace, connect = connectCustomDomain, check = checkCustomDomain, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), loadDomain = loadCustomDomainForTool },
) {
  await authorizeWorkspace(db, { customerId, workspaceId });
  const connected = await connect(db, { customerId, workspaceId, appId, domain });
  if (connected.alreadyConnected) await check(db, { customerId, workspaceId, appId });
  let current = connected.domain;
  for (let attempt = 0; attempt < 6 && current?.status === "PENDING"; attempt++) {
    await wait(2000);
    current = (await loadDomain(db, { customerId, workspaceId, appId })) ?? current;
  }
  return toolDomainView(current);
}

async function loadCustomDomainForTool(db, identity) {
  return (await getAppCustomDomain(db, identity)).domain;
}

function toolDomainView(domain) {
  if (!domain) return { status: "NONE", message: "No custom domain is connected." };
  const view = {
    domain: domain.domain,
    status: domain.status,
    url: domain.url,
    message: domain.message,
    dnsProvider: domain.provider?.name ?? null,
  };
  if (domain.records?.length || domain.remove?.length) {
    view.addRecords = domain.records.map(({ type, name, value }) => ({ type, name, value }));
    view.deleteRecords = domain.remove.map(({ type, name, value }) => ({ type, name, value }));
    view.steps = domain.steps;
  }
  if (domain.status === "PENDING") view.message = `Connecting ${domain.domain}. Call connect_domain again in a few seconds to get the DNS records to add.`;
    return view;
}
