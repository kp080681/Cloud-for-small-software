"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function GitHubPanel({ workspaceId, github }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [repositoryState, setRepositoryState] = useState(null);
  const [message, setMessage] = useState("");

  async function loadRepositories() {
    setMessage("");
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/github/repositories`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(body.error || "GITHUB_REPOSITORIES_UNAVAILABLE");
      return;
    }
    setRepositoryState(body);
  }

  async function selectRepository(installationId, repositoryId) {
    setMessage("");
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/github/repositories/select`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId, repositoryId }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(body.error || "REPOSITORY_NOT_AVAILABLE");
      return;
    }
    setMessage(`${body.repository.fullName} selected.`);
    startTransition(() => router.refresh());
    await loadRepositories();
  }

  const groups = repositoryState?.installations ?? [];

  return (
    <section id="github-connection" className="panel section-gap github-panel">
      <div className="row">
        <div>
          <h2>GitHub</h2>
          <small>{github.connected ? "Connected through the Utplava GitHub App" : "Connect repository access for this workspace"}</small>
        </div>
        <span className={`status ${github.connected ? "live" : "neutral"}`}>
          <span className="dot" aria-hidden="true" />
          {github.connected ? "Connected" : "Not connected"}
        </span>
      </div>

      <div className="github-actions">
        <form action="/api/github/install/start" method="post">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <button type="submit">Connect GitHub</button>
        </form>
        <button type="button" onClick={loadRepositories} disabled={!github.connected || isPending}>
          List repositories
        </button>
      </div>

      {github.selectedRepositories.length ? (
        <div className="selected-repos">
          {github.selectedRepositories.map((repository) => (
            <span key={repository.id}>{repository.fullName}</span>
          ))}
        </div>
      ) : null}

      {message ? <p className="helptext" role="status">{message}</p> : null}

      {repositoryState?.connectionStatus === "NOT_CONNECTED" ? (
        <p className="helptext">Choose which repositories Utplava can access in GitHub, then return here.</p>
      ) : null}

      {groups.length ? (
        <div className="repository-list">
          {groups.map((group) => (
            <div key={group.installation.githubInstallationId} className="repository-group">
              <div className="repo-group-title">{group.installation.accountLogin}</div>
              {group.error ? <p className="helptext">{group.error}</p> : null}
              {group.repositories.length === 0 && !group.error ? (
                <p className="helptext">No repositories are available to this installation.</p>
              ) : null}
              {group.repositories.map((repository) => (
                <div className="repo" key={repository.githubRepositoryId}>
                  <span className="repo-left">
                    <span className="repo-icon">{repository.name.slice(0, 1).toUpperCase()}</span>
                    <span>
                      <strong>{repository.fullName}</strong>
                      <small>{repository.private ? "Private" : "Public"} - {repository.defaultBranch}</small>
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      selectRepository(group.installation.githubInstallationId, repository.githubRepositoryId)
                    }
                    disabled={repository.selected || isPending}
                  >
                    {repository.selected ? "Selected" : "Select"}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
