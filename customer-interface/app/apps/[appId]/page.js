import Link from "next/link";
import { redirect } from "next/navigation";
import { getCustomerShell } from "@/src/server/customer-shell.mjs";
import { connectDatabase } from "@/src/server/db.mjs";
import { listAppDeployments } from "@/src/server/customer-workspaces.mjs";
import { friendlyErrorMessage } from "@/src/shared/deployment-ui-state.mjs";
import { GitHubPanel } from "../../github-panel.js";
import { AutoDeployToggle } from "../../auto-deploy-toggle.js";
import { DeleteAppCard } from "../../delete-app-card.js";
import { DatabaseCard } from "../../database-card.js";
import { RestoreButton } from "../../restore-button.js";
import { getAppDatabaseSummary } from "@/src/server/customer-app-database.mjs";
import { Chrome, Status, appStatus, timeAgo, workspaceHref } from "../../ui.js";

export const dynamic = "force-dynamic";

const RUNNING = new Set(["QUEUED", "PROVISIONING", "BUILDING", "DEPLOYING", "HEALTH_CHECKING"]);

function reasonLabel(deployment) {
  switch (deployment.reason) {
    case "push": return `Pushed to ${deployment.branch || "main"}`;
    case "redeploy": return "Redeployed";
    case "rollback": return "Rolled back";
    default: return "Deployed";
  }
}

// History rows: the newest LIVE deployment is the one serving; older LIVE
// ones were replaced by it.
// A version that once went live, with different code from what's serving,
// can be restored with one click (2026-10-25). Hidden while a deploy runs.
function canRestore(deployment, servingCommit) {
  return deployment.status === "LIVE" && Boolean(deployment.shortCommitSha) && deployment.shortCommitSha !== servingCommit;
}

function historyOutcome(deployment, isServing) {
  if (deployment.status === "LIVE") return isServing ? { tone: "live", text: "Live" } : { tone: "", text: "Replaced" };
  if (deployment.status === "FAILED") {
    const reason = deployment.errorCode ? friendlyErrorMessage(deployment.errorCode, "") : "";
    return { tone: "failed", text: reason ? `Failed: ${reason}` : "Failed" };
  }
  if (RUNNING.has(deployment.status)) return { tone: "working", text: "Deploying" };
  if (deployment.status === "ANALYZING") return { tone: "", text: "Checked, not deployed" };
  return { tone: "", text: deployment.status.toLowerCase().replace(/_/g, " ") };
}

export default async function AppPage({ params, searchParams }) {
  const { appId } = await params;
  const query = await searchParams;
  const workspaceId = typeof query?.workspace === "string" ? query.workspace : null;
  const shell = await getCustomerShell({ selectedWorkspaceId: workspaceId });
  if (!shell.authenticated) redirect("/");

  const active = shell.currentWorkspace;
  const app = shell.apps.find((candidate) => candidate.id === appId);
  if (!app) {
    return (
      <Chrome shell={shell} active="apps">
        <div className="crumb"><Link href={workspaceHref("/", active.id)}>Apps</Link></div>
        <section className="panel empty">
          <h2>This app isn&apos;t in this workspace.</h2>
          <p className="muted">It may have been deleted, or it belongs to another workspace.</p>
          <Link className="button" href={workspaceHref("/", active.id)}>Back to apps</Link>
        </section>
      </Chrome>
    );
  }

  const db = await connectDatabase();
  let history = [];
  let database = null;
  try {
    history = await listAppDeployments(db, { customerId: shell.user.id, workspaceId: active.id, appId: app.id });
    database = await getAppDatabaseSummary(db, { customerId: shell.user.id, workspaceId: active.id, appId: app.id });
  } finally {
    await db.end();
  }
  const servingId = history.find((deployment) => deployment.status === "LIVE")?.id ?? null;
  const servingCommit = history.find((deployment) => deployment.id === servingId)?.shortCommitSha ?? null;
  const anyRunning = history.some((deployment) => !["LIVE", "FAILED"].includes(deployment.status) && deployment.status !== "DELETED");
  const status = appStatus(app);

  return (
    <Chrome shell={shell} active="apps">
      <div className="crumb">
        <Link href={workspaceHref("/", active.id)}>Apps</Link>
        <span className="sep">/</span>
        <span>{app.name}</span>
      </div>
      <div className="title-row">
        <h1>
          {app.name}
          <Status tone={status.tone}>{status.label}</Status>
        </h1>
        <div className="title-actions">
          {app.liveUrl ? <a className="button" href={app.liveUrl} target="_blank" rel="noreferrer">Visit ↗</a> : null}
        </div>
      </div>
      <p className="title-sub">
        {[app.repositoryFullName, app.defaultBranch, app.framework === "nextjs" ? "Next.js" : app.framework].filter(Boolean).join(" · ")}
      </p>

      <GitHubPanel workspaceId={active.id} github={shell.github} mode="app" repositoryId={app.repositoryId} />

      <section className="card">
        <div className="setting-row">
          <div>
            <strong>Deploy on push</strong>
            <small>
              Every push to <span className="mono">{app.defaultBranch || "main"}</span> on GitHub redeploys this app automatically.
            </small>
          </div>
          <AutoDeployToggle workspaceId={active.id} appId={app.id} initialEnabled={app.autoDeployOnPush} labelMode="state" />
        </div>
      </section>

      <section className="card">
        <h2>Deployments</h2>
        <p className="card-sub">The most recent first.</p>
        {history.length ? (
          <div className="history">
            {history.map((deployment) => {
              const outcome = historyOutcome(deployment, deployment.id === servingId);
              return (
                <div className="history-row" key={deployment.id}>
                  <span className={`history-dot ${outcome.tone}`} aria-hidden="true" />
                  <span className="what">
                    <span className="mono">{deployment.shortCommitSha || "—"}</span> · {reasonLabel(deployment)} · {outcome.text}
                  </span>
                  <span className="when">
                    {!anyRunning && deployment.id !== servingId && canRestore(deployment, servingCommit) ? (
                      <RestoreButton workspaceId={active.id} appId={app.id} deploymentId={deployment.id} label={deployment.shortCommitSha || "this version"} />
                    ) : null}
                    {timeAgo(deployment.finishedAt || deployment.createdAt)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted fine">No deployments yet.</p>
        )}
      </section>

      {database ? <DatabaseCard workspaceId={active.id} appId={app.id} ready={database.ready} /> : null}

      <DeleteAppCard workspaceId={active.id} appId={app.id} appName={app.name} homeHref={workspaceHref("/", active.id)} />
    </Chrome>
  );
}
