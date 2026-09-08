import { redirect } from "next/navigation";
import { getCustomerShell } from "@/src/server/customer-shell.mjs";
import { selectedWorkspaceCookieName } from "@/src/server/session.mjs";
import { WorkspaceSelectForm, WorkspaceRenameForm } from "./workspace-forms.js";
import { GitHubPanel } from "./github-panel.js";

export const dynamic = "force-dynamic";

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="8" width="13" height="13" rx="1.5" />
      <rect x="9" y="1" width="13" height="13" rx="1.5" />
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

function Applications({ apps }) {
  if (!apps.length) {
    return (
      <>
        <div className="heading">
          <div>
            <h1>Applications</h1>
            <p className="muted">Everything you build starts somewhere.</p>
          </div>
          <button disabled>Deploy an application</button>
        </div>
        <section className="panel empty">
          <div className="symbol" aria-hidden="true">+</div>
          <h2>Your workspace is ready.</h2>
          <p className="muted">GitHub repository connection arrives in the next integration node. No infrastructure operation is available from this shell yet.</p>
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
        <button disabled>Deploy an application</button>
      </div>
      <section className="panel application-list">
        {apps.map((app) => (
          <div className="repo" key={app.id}>
            <span className="repo-left">
              <span className="repo-icon">{app.name.slice(0, 1).toUpperCase()}</span>
              <span>
                <strong>{app.name}</strong>
                <small>{app.slug}</small>
                <small>{app.latestDeploymentStatus ? `Latest deployment ${app.latestDeploymentStatus}` : "No deployments yet"}</small>
              </span>
            </span>
            <Status tone={app.liveUrl ? "live" : "neutral"}>{app.liveUrl ? "Live" : "Not live"}</Status>
          </div>
        ))}
      </section>
    </>
  );
}

export default async function Home({ searchParams }) {
  const params = await searchParams;
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
        </aside>
        <main id="main-content">
          <div className="crumb"><span>Applications</span></div>
          <Applications apps={shell.apps} />
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
        </main>
      </div>
    </>
  );
}
