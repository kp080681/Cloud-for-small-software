import Link from "next/link";
import { redirect } from "next/navigation";
import { getCustomerShell } from "@/src/server/customer-shell.mjs";
import { GitHubPanel } from "../github-panel.js";
import { Chrome, workspaceHref } from "../ui.js";

export const dynamic = "force-dynamic";

// Adding an app: connect GitHub if needed, pick a repository, let Utplava
// analyse it, deploy. Repositories that already have a live app are left
// out (they're managed from their own app page).
export default async function NewAppPage({ searchParams }) {
  const query = await searchParams;
  const workspaceId = typeof query?.workspace === "string" ? query.workspace : null;
  const shell = await getCustomerShell({ selectedWorkspaceId: workspaceId });
  if (!shell.authenticated) redirect("/");

  const active = shell.currentWorkspace;
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
          <p className="muted">Choose a GitHub repository. Utplava works out how to run it and puts it on the internet.</p>
        </div>
      </div>
      <GitHubPanel workspaceId={active.id} github={shell.github} mode="new" hideRepositoryIds={liveRepositoryIds} />
    </Chrome>
  );
}
