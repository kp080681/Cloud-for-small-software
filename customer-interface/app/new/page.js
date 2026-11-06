import Link from "next/link";
import { redirect } from "next/navigation";
import { getCustomerShell } from "@/src/server/customer-shell.mjs";
import { GitHubPanel } from "../github-panel.js";
import { UploadPanel } from "../upload-panel.js";
import { Chrome, workspaceHref } from "../ui.js";

export const dynamic = "force-dynamic";

// Adding an app, two ways (2026-11-06): upload files or paste HTML, with
// no GitHub needed; or connect GitHub, pick a repository, let Utplava
// analyse it, deploy. Repositories that already have a live app are left
// out (they're managed from their own app page).
export default async function NewAppPage({ searchParams }) {
  const query = await searchParams;
  const workspaceId = typeof query?.workspace === "string" ? query.workspace : null;
  const shell = await getCustomerShell({ selectedWorkspaceId: workspaceId });
  if (!shell.authenticated) redirect("/");

  const active = shell.currentWorkspace;
  const focusRepository = typeof query?.repo === "string" ? query.repo : null;
  const liveRepositoryIds = shell.apps.filter((app) => app.liveUrl && app.repositoryId).map((app) => app.repositoryId);

  return (
    <Chrome shell={shell} active="apps">
      <div className="crumb">
        <Link href={workspaceHref("/", active.id)}>Apps</Link>
        <span className="sep">/</span>
        <span>New app</span>
      </div>
      <div className="heading">
        <div>
          <h1>New app</h1>
          <p className="muted">Upload your app, or pick it from GitHub. Utplava works out how to run it and puts it on the internet.</p>
        </div>
      </div>
      {focusRepository ? null : <UploadPanel workspaceId={active.id} />}
      {focusRepository ? null : (
        <div className="new-app-or">
          <h2>Or deploy from GitHub</h2>
          <p className="muted">Best for bigger apps, and for apps you keep changing: every push to GitHub updates the live site.</p>
        </div>
      )}
      <GitHubPanel
        workspaceId={active.id}
        github={shell.github}
        mode="new"
        hideRepositoryIds={liveRepositoryIds}
        initialFocusRepositoryId={focusRepository}
      />
    </Chrome>
  );
}
