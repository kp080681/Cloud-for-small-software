import Link from "next/link";
import { redirect } from "next/navigation";
import { getCustomerShell } from "@/src/server/customer-shell.mjs";
import { safeReturnTo } from "@/src/server/mcp-registration.mjs";
import { githubInstallCallbackRedirectPath } from "@/src/server/github-install-state.mjs";
import { SignInOptions } from "./sign-in-options.js";
import { Brand, Chrome, Status, appStatus, isProviderUrl, timeAgo, workspaceHref } from "./ui.js";

export const dynamic = "force-dynamic";

function SignIn({ returnTo = null }) {
  return (
    <main className="sign-in">
      <Brand />
      <h1>You built the app.<br />Now put it online.</h1>
      <p className="muted">Paste or upload your app, or bring it from GitHub. Free for up to 3 apps, no card needed.</p>
      <section className="panel">
        <h2>Sign in to Utplava</h2>
        <SignInOptions returnTo={returnTo} />
        <ul className="sign-in-notes">
          <li>Utplava only gets your name and email. It never sees your password.</li>
          <li>Built in ChatGPT or Claude? Paste the page it wrote and get a live link. No GitHub needed.</li>
          <li>Built in Lovable or keep your code on GitHub? <a href="https://utplava.dev/guides/lovable/" target="_blank" rel="noreferrer">Continue with GitHub</a> and pick your app.</li>
        </ul>
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

  if (!shell.authenticated) return <SignIn returnTo={safeReturnTo(typeof params?.return_to === "string" ? params.return_to : null)} />;
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
          <h2>You&apos;re in. Let&apos;s put your first app online.</h2>
          <p className="muted">Choose the app you want to put online. Utplava works out how to run it and tells you if it needs anything from you.</p>
          <Link className="button primary" href={newAppHref}>Put my first app online</Link>
          <div className="empty-footer">
            <span>Code from your GitHub</span>
            <span>Next.js, React, Vite, Lovable</span>
            <span>A database, when it needs one</span>
          </div>
        </section>
      )}
    </Chrome>
  );
}
