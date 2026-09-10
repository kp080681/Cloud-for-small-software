"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function GitHubPanel({ workspaceId, github }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [repositoryState, setRepositoryState] = useState(null);
  const [analysisState, setAnalysisState] = useState({});
  const [configurationState, setConfigurationState] = useState({});
  const [secretInputs, setSecretInputs] = useState({});
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

  async function analyseRepository(repositoryId) {
    setMessage("");
    setAnalysisState((current) => ({
      ...current,
      [repositoryId]: { pending: true },
    }));
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/analysis`,
      { method: "POST" },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = body.message || body.error || "Repository analysis could not be completed.";
      setAnalysisState((current) => ({
        ...current,
        [repositoryId]: { pending: false, error },
      }));
      setMessage(error);
      return;
    }
    setAnalysisState((current) => ({
      ...current,
      [repositoryId]: { pending: false, analysis: body.analysis },
    }));
    if (body.analysis?.appId) {
      await loadConfiguration(body.analysis.appId);
    }
    startTransition(() => router.refresh());
  }

  async function loadConfiguration(appId) {
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/applications/${encodeURIComponent(appId)}/configuration`,
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(body.error || "CONFIGURATION_STATUS_UNAVAILABLE");
      return;
    }
    setConfigurationState((current) => ({
      ...current,
      [appId]: body.configuration,
    }));
  }

  async function saveSecret(appId, envKey) {
    setMessage("");
    const inputKey = `${appId}:${envKey}`;
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/applications/${encodeURIComponent(appId)}/configuration/secrets`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envKey, value: secretInputs[inputKey] || "" }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(body.error || "SECRET_CONFIGURATION_FAILED");
      return;
    }
    setConfigurationState((current) => ({
      ...current,
      [appId]: body.configuration,
    }));
    setSecretInputs((current) => ({ ...current, [inputKey]: "" }));
    setMessage(`${envKey} configured.`);
    startTransition(() => router.refresh());
  }

  const groups = repositoryState?.installations ?? [];
  const analysesByRepository = new Map(
    (github.repositoryAnalyses ?? []).map((analysis) => [analysis.repositoryId, analysis]),
  );
  const configurationByApp = new Map(
    (github.configurationStatuses ?? []).map((configuration) => [configuration.appId, configuration]),
  );

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
        <div className="analysis-list">
          {github.selectedRepositories.map((repository) => {
            const transient = analysisState[repository.id];
            const analysis = transient?.analysis ?? analysesByRepository.get(repository.id);
            const isAnalysing = Boolean(transient?.pending);
            return (
              <div className="analysis-item" key={repository.id}>
                <div className="row">
                  <div>
                    <h3>{repository.name}</h3>
                    <small>{repository.fullName} - {repository.defaultBranch}</small>
                  </div>
                  <button type="button" onClick={() => analyseRepository(repository.id)} disabled={isPending || isAnalysing}>
                    {analysis ? "Analyse again" : "Analyse project"}
                  </button>
                </div>

                {isAnalysing ? (
                  <div className="analysis-progress" role="status">
                    <span>Analysing repository...</span>
                    <span>Source identified</span>
                    <span>Framework detected</span>
                    <span>Requirements detected</span>
                  </div>
                ) : null}

                {transient?.error ? <p className="helptext" role="status">{transient.error}</p> : null}

                {analysis ? (
                  <AnalysisResult
                    analysis={analysis}
                    configuration={configurationState[analysis.appId] ?? configurationByApp.get(analysis.appId)}
                    secretInputs={secretInputs}
                    setSecretInputs={setSecretInputs}
                    saveSecret={saveSecret}
                    isPending={isPending}
                  />
                ) : null}
              </div>
            );
          })}
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

function AnalysisResult({ analysis, configuration, secretInputs, setSecretInputs, saveSecret, isPending }) {
  const handled = [
    analysis.framework ? `Framework ${analysis.framework}` : null,
    analysis.runtime ? `Runtime ${analysis.runtime}` : null,
    analysis.packageManager ? `Package manager ${analysis.packageManager}` : null,
    analysis.buildCommand ? `Build ${analysis.buildCommand}` : null,
    analysis.databaseRequired ? `PostgreSQL ${analysis.databaseMode || "required"}` : "No database required",
  ].filter(Boolean);
  const requirements = configuration?.requirements ?? [];
  const requiredMissing = requirements.filter((item) => item.required && !item.managed && !item.configured);
  const configured = requirements.filter((item) => item.required && !item.managed && item.configured);
  const managed = requirements.filter((item) => item.managed);
  const optional = requirements.filter((item) => !item.required && !item.managed);
  const ready = configuration?.readiness === "READY_TO_DEPLOY";

  return (
    <div className="analysis-result">
      <div>
        <strong>Source identified</strong>
        <small>{analysis.branch} - {analysis.shortCommitSha || "pending"}</small>
      </div>
      <div className="analysis-columns">
        <div>
          <strong>Handled by Utplava</strong>
          {handled.length ? handled.map((item) => <small key={item}>{item}</small>) : <small>Analysis is pending.</small>}
          {managed.map((item) => <small key={item.envKey}>{item.envKey} handled by Utplava</small>)}
        </div>
        <div>
          <strong>Your attention</strong>
          {analysis.errorCode ? <small>Unsupported: {analysis.errorCode}</small> : null}
          {requiredMissing.map((item) => {
            const inputKey = `${analysis.appId}:${item.envKey}`;
            return (
              <label className="secret-field" key={item.envKey}>
                <span>{item.envKey} Required</span>
                <span className="secret-entry">
                  <input
                    type="password"
                    value={secretInputs[inputKey] || ""}
                    onChange={(event) =>
                      setSecretInputs((current) => ({ ...current, [inputKey]: event.target.value }))
                    }
                    autoComplete="off"
                  />
                  <button type="button" onClick={() => saveSecret(analysis.appId, item.envKey)} disabled={isPending}>
                    Save
                  </button>
                </span>
              </label>
            );
          })}
          {configured.map((item) => <small key={item.envKey}>{item.envKey} Configured</small>)}
          {!analysis.errorCode && !requiredMissing.length && !configured.length ? <small>No required action detected.</small> : null}
        </div>
      </div>
      <div className="configuration-state">
        <strong>Configuration</strong>
        {requirements.length ? null : <small>No configuration required.</small>}
        {optional.map((item) => <small key={item.envKey}>{item.envKey} detected, optional / not blocking</small>)}
        <small>{ready ? "Ready to deploy" : configuration?.readiness || "Configuration status pending"}</small>
      </div>
    </div>
  );
}
