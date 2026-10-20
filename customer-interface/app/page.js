import Link from "next/link";
import { redirect } from "next/navigation";
import { getCustomerShell } from "@/src/server/customer-shell.mjs";
import { githubInstallCallbackRedirectPath } from "@/src/server/github-install-state.mjs";
import { Brand, Chrome, Status, appStatus, isProviderUrl, timeAgo, workspaceHref } from "./ui.js";

export const dynamic = "force-dynamic";

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

function appMeta(app, status) {
  if (status.tone === "working") {
    return app.latestDeploymentReason === "push" ? "New push · deploying now" : "Deploying now";
  }
  if (status.tone === "failed") return "Last deployment failed";
  if (app.liveUrl) {
    const when = timeAgo(app.liveDeployedAt);
    const branch = app.defaultBranch ? ` from ${app.defaultBranch}` : "";
    return when ? `Deployed ${when}${branch}` : "Live";
  }
  return "Not deployed yet";
}

function AppList({ apps, workspaceId }) {
  return (
    <section className="panel app-list">
      {apps.map((app) => {
        const status = appStatus(app);
        return (
          <Link className="app-row" key={app.id} href={workspaceHref(`/apps/${app.id}`, workspaceId)}>
            <span className="repo-icon">{app.name.slice(0, 1).toUpperCase()}</span>
            <span className="app-row-name">
              <strong>{app.name}</strong>
              <small>{app.repositoryFullName || app.slug}</small>
            </span>
            <span className="app-row-url">
              {app.liveUrl && !isProviderUrl(app.liveUrl) ? (
                <span>{app.liveUrl.replace(/^https?:\/\//, "")}</span>
              ) : app.liveUrl ? (
                <span className="muted">Setting up utplava.dev link</span>
              ) : (
                <span className="muted">Not live yet</span>
              )}
              <small>{appMeta(app, status)}</small>
            </span>
            <Status tone={status.tone}>{status.label}</Status>
          </Link>
        );
      })}
    </section>
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
  const newAppHref = workspaceHref("/new", active.id);
  return (
    <Chrome shell={shell} active="apps">
      <div className="heading">
        <div>
          <h1>Apps</h1>
          <p className="muted">Everything you&apos;ve put on the internet.</p>
        </div>
        <Link className="button" href={newAppHref}>New app</Link>
      </div>
      {shell.apps.length ? (
        <AppList apps={shell.apps} workspaceId={active.id} />
      ) : (
        <section className="panel empty">
          <div className="symbol" aria-hidden="true">+</div>
          <h2>Your workspace is ready.</h2>
          <p className="muted">Pick a GitHub repository and Utplava will put it on the internet.</p>
          <Link className="button" href={newAppHref}>Deploy your first app</Link>
          <div className="empty-footer">
            <span>GitHub source</span>
            <span>Next.js + Node.js</span>
            <span>PostgreSQL, when needed</span>
          </div>
        </section>
      )}
    </Chrome>
  );
}
