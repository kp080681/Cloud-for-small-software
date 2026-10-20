import { redirect } from "next/navigation";
import { getCustomerShell } from "@/src/server/customer-shell.mjs";
import { githubInstallCallbackRedirectPath } from "@/src/server/github-install-state.mjs";
import { selectedWorkspaceCookieName } from "@/src/server/session.mjs";
import { WorkspaceSelectForm, WorkspaceRenameForm } from "./workspace-forms.js";
import { GitHubPanel } from "./github-panel.js";
import { McpGrantsPanel } from "./mcp-grants-panel.js";
import { AutoDeployToggle } from "./auto-deploy-toggle.js";

export const dynamic = "force-dynamic";

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect className="mark-tile" x="0.5" y="0.5" width="23" height="23" rx="5.4" />
      <line className="mark-horizon" x1="3.75" y1="16.4" x2="20.25" y2="16.4" />
      <path className="mark-sun" d="M 5,16.4 A 7,7 0 0 1 19,16.4 Z" />
    </svg>
  );
}

function Brand() {
  return (
    <div className="brand">
      <Mark />
      utplava
    </div>
  );
}

function Status({ children, tone = "neutral" }) {
  return (
    <span className={`status ${tone}`}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

function SignIn() {
  return (
    <main className="sign-in">
      <Brand />
      <h1>Build anywhere.<br />Run here.</h1>
      <p className="muted">A home for the software you have built.</p>
      <section className="panel">
        <h2>Sign in to Utplava</h2>
        <p className="fine muted">Use your GitHub account to continue.</p>
        <a className="button primary" href="/api/auth/github/start">Continue with GitHub</a>
        <p className="helptext">Repository access is a separate step. You choose what Utplava can access.</p>
      </section>
    </main>
  );
}

function Applications({ apps, workspaceId }) {
  if (!apps.length) {
    return (
      <>
        <div className="heading">
          <div>
            <h1>Applications</h1>
            <p className="muted">Everything you build starts somewhere.</p>
          </div>
          <a className="button" href="#github-connection">Deploy an application</a>
        </div>
        <section className="panel empty">
          <div className="symbol" aria-hidden="true">+</div>
          <h2>Your workspace is ready.</h2>
          <p className="muted">Connect a GitHub repository below to deploy your first app.</p>
          <div className="empty-footer">
            <span>GitHub source</span>
            <span>Next.js + Node.js</span>
            <span>PostgreSQL, when needed</span>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <div className="heading">
        <div>
          <h1>Applications</h1>
          <p className="muted">Your software, all in one place.</p>
        </div>
        <a className="button" href="#github-connection">Deploy an application</a>
      </div>
      <section className="panel application-list">
        {apps.map((app) => (
          <div className="repo" key={app.id}>
            <span className="repo-left">
              <span className="repo-icon">{app.name.slice(0, 1).toUpperCase()}</span>
              <span>
                <strong>{app.name}</strong>
                <small className="mono">{app.slug}</small>
                <small>{app.latestDeploymentStatus ? `Latest deployment ${app.latestDeploymentStatus}` : "No deployments yet"}</small>
              </span>
            </span>
            <span className="repo-right">
              <AutoDeployToggle workspaceId={workspaceId} appId={app.id} initialEnabled={app.autoDeployOnPush} />
              {app.liveUrl ? (
                <a className="app-link mono" href={app.liveUrl} target="_blank" rel="noreferrer">
                  {app.liveUrl.replace(/^https?:\/\//, "")}
                </a>
              ) : null}
              <Status tone={app.liveUrl ? "live" : "neutral"}>{app.liveUrl ? "Live" : "Not live"}</Status>
            </span>
          </div>
        ))}
      </section>
    </>
  );
}

export default async function Home({ searchParams }) {
  const params = await searchParams;
  const githubInstallCallback = githubInstallCallbackRedirectPath(params);
  if (githubInstallCallback) redirect(githubInstallCallback);

  const workspaceId = typeof params?.workspace === "string" ? params.workspace : null;
  const shell = await getCustomerShell({ selectedWorkspaceId: workspaceId });

  if (!shell.authenticated) return <SignIn />;
  if (shell.selectedWorkspaceId && workspaceId !== shell.selectedWorkspaceId) {
    redirect(`/?workspace=${encodeURIComponent(shell.selectedWorkspaceId)}`);
  }

  const active = shell.currentWorkspace;
  return (
    <>
      <header>
        <div className="header-left">
          <Brand />
          <WorkspaceSelectForm workspaces={shell.workspaces} selectedWorkspaceId={active.id} cookieName={selectedWorkspaceCookieName} />
        </div>
        <div className="header-right">
          <span className="prototype">V1</span>
          <span className="avatar" aria-label="Signed in account">{shell.user.login.slice(0, 2).toUpperCase()}</span>
          <form action="/api/auth/sign-out" method="post">
            <button className="plain">Sign out</button>
          </form>
        </div>
      </header>
      <div className="shell">
        <aside>
          <button className="active">Applications</button>
          <div className="nav-caption">Workspace</div>
          <a className="nav-link" href="#github-connection">GitHub connection</a>
          <a className="nav-link" href="#mcp-connections">Connected apps</a>
        </aside>
        <main id="main-content">
          <div className="crumb"><span>Applications</span></div>
          <Applications apps={shell.apps} workspaceId={active.id} />
          <section className="panel section-gap">
            <div className="row">
              <div>
                <h2>Workspace</h2>
                <small>{active.name}</small>
              </div>
              <Status>Authorized</Status>
            </div>
            <WorkspaceRenameForm workspace={active} />
          </section>
          <GitHubPanel workspaceId={active.id} github={shell.github} />
          <McpGrantsPanel workspaceId={active.id} />
        </main>
      </div>
    </>
  );
}
