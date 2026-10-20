import Link from "next/link";
import { redirect } from "next/navigation";
import { getCustomerShell } from "@/src/server/customer-shell.mjs";
import { WorkspaceRenameForm } from "../workspace-forms.js";
import { McpGrantsPanel } from "../mcp-grants-panel.js";
import { Chrome, Status, workspaceHref } from "../ui.js";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }) {
  const query = await searchParams;
  const workspaceId = typeof query?.workspace === "string" ? query.workspace : null;
  const shell = await getCustomerShell({ selectedWorkspaceId: workspaceId });
  if (!shell.authenticated) redirect("/");

  const active = shell.currentWorkspace;
  const github = shell.github;
  const accounts = github.installations?.length ?? 0;

  return (
    <Chrome shell={shell} active="settings">
      <div className="heading">
        <div>
          <h1>Settings</h1>
          <p className="muted">Your workspace, GitHub access and connected AI tools.</p>
        </div>
      </div>

      <section className="card">
        <WorkspaceRenameForm workspace={active} />
      </section>

      <section className="card">
        <div className="setting-row">
          <div>
            <strong>GitHub</strong>
            <small>
              {github.connected
                ? `Connected through the Utplava GitHub App · ${accounts} account${accounts === 1 ? "" : "s"}`
                : "Not connected yet. Connect GitHub to deploy your repositories."}
            </small>
          </div>
          <div className="title-actions">
            <Status tone={github.connected ? "live" : "neutral"}>{github.connected ? "Connected" : "Not connected"}</Status>
            <form action="/api/github/install/start" method="post">
              <input type="hidden" name="workspaceId" value={active.id} />
              <button type="submit">{github.connected ? "Manage access" : "Connect GitHub"}</button>
            </form>
          </div>
        </div>
        {github.connected ? (
          <p className="helptext">
            To deploy another repository, go to <Link href={workspaceHref("/new", active.id)}>New app</Link>.
          </p>
        ) : null}
      </section>

      <McpGrantsPanel workspaceId={active.id} />
    </Chrome>
  );
}
