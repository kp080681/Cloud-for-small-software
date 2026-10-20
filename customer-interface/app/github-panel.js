"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deploymentStageIndex,
  deploymentStageOrder,
  deploymentStageTrackerLabel,
  friendlyErrorMessage,
  readinessLabel,
  redeployFailureMessage,
  redeploySuccessMessage,
  retrySuccessMessage,
  stageLabelForStatus,
} from "@/src/shared/deployment-ui-state.mjs";

export function GitHubPanel({ workspaceId, github }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [repositoryState, setRepositoryState] = useState(null);
  const [analysisState, setAnalysisState] = useState({});
  const [configurationState, setConfigurationState] = useState({});
  const [deploymentState, setDeploymentState] = useState({});
  const [deploymentErrors, setDeploymentErrors] = useState({});
  const [deploymentPending, setDeploymentPending] = useState({});
  const [secretInputs, setSecretInputs] = useState({});
  const [message, setMessage] = useState("");

  async function loadRepositories() {
    setMessage("");
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/github/repositories`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(friendlyErrorMessage(body.error, "Utplava couldn't load your GitHub repositories. Try refreshing the page."));
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
      setMessage(friendlyErrorMessage(body.error, "That repository isn't available to select right now."));
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
    let response;
    try {
      response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}/analysis`,
        { method: "POST" },
      );
    } catch {
      // The request never reached a response at all (dropped connection,
      // offline, a gateway timing out the connection outright). Without
      // this, analysisState stayed pending forever with no way to recover
      // short of a page refresh.
      const error = "Repository analysis didn't finish — the connection was interrupted. Try again.";
      setAnalysisState((current) => ({
        ...current,
        [repositoryId]: { pending: false, error },
      }));
      setMessage(error);
      return;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = body.message || friendlyErrorMessage(body.error, "Repository analysis could not be completed.");
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
      setMessage(friendlyErrorMessage(body.error, "Utplava couldn't check this app's configuration. Try refreshing the page."));
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
      setMessage(friendlyErrorMessage(body.error, "That value couldn't be saved. Please try again."));
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

  async function loadDeploymentProgress(appId, deploymentId, { silent = false, autoResume = false } = {}) {
    const query = autoResume ? "?resume=auto" : "";
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/applications/${encodeURIComponent(appId)}/deployments/${encodeURIComponent(deploymentId)}${query}`,
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (!silent) setMessage(friendlyErrorMessage(body.error, "Utplava couldn't check on this deployment. Try refreshing the page."));
      return null;
    }
    setDeploymentState((current) => ({
      ...current,
      [deploymentId]: body.deployment,
    }));
    return body.deployment;
  }

  async function startDeployment(appId, deploymentId) {
    setMessage("");
    setDeploymentPending((current) => ({ ...current, [deploymentId]: true }));
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/applications/${encodeURIComponent(appId)}/deployments/${encodeURIComponent(deploymentId)}/start`,
      { method: "POST" },
    );
    const body = await response.json().catch(() => ({}));
    setDeploymentPending((current) => ({ ...current, [deploymentId]: false }));
    if (!response.ok) {
      setMessage(friendlyErrorMessage(body.error, "The deployment couldn't be started. Please try again."));
      return;
    }
    setDeploymentState((current) => ({
      ...current,
      [deploymentId]: body.deployment,
    }));
    setMessage("Deployment started.");
    startTransition(() => router.refresh());
  }

  async function retryDeployment(appId, deploymentId, analysisDeploymentId = deploymentId) {
    setMessage("");
    setDeploymentPending((current) => ({ ...current, [deploymentId]: true }));
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/applications/${encodeURIComponent(appId)}/deployments/${encodeURIComponent(deploymentId)}/retry`,
      { method: "POST" },
    );
    const body = await response.json().catch(() => ({}));
    setDeploymentPending((current) => ({ ...current, [deploymentId]: false }));
    if (!response.ok) {
      setMessage(friendlyErrorMessage(body.error, "The retry couldn't be started. Please try again."));
      return;
    }
    setDeploymentState((current) => ({
      ...current,
      [analysisDeploymentId]: body.deployment,
      [body.deployment.deploymentId]: body.deployment,
    }));
    setMessage(retrySuccessMessage(body.deployment));
    startTransition(() => router.refresh());
  }

  async function redeployApp(appId, analysisDeploymentId) {
    setMessage("");
    setDeploymentErrors((current) => ({ ...current, [analysisDeploymentId]: "" }));
    setDeploymentPending((current) => ({ ...current, [analysisDeploymentId]: true }));
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/applications/${encodeURIComponent(appId)}/redeploy`,
      { method: "POST" },
    );
    const body = await response.json().catch(() => ({}));
    setDeploymentPending((current) => ({ ...current, [analysisDeploymentId]: false }));
    if (!response.ok) {
      const error = redeployFailureMessage(body.error);
      setDeploymentErrors((current) => ({ ...current, [analysisDeploymentId]: error }));
      setMessage(error);
      return;
    }
    setDeploymentState((current) => ({
      ...current,
      [analysisDeploymentId]: body.deployment,
      [body.deployment.deploymentId]: body.deployment,
    }));
    setDeploymentErrors((current) => ({ ...current, [analysisDeploymentId]: "" }));
    setMessage(redeploySuccessMessage(body.deployment));
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
                    <span className="thinking-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    <div>
                      <div>Analysing your repository</div>
                      <small className="analysis-progress-detail">Checking the source, framework, and what it needs to run</small>
                    </div>
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
                    deployment={
                      deploymentState[analysis.deploymentId]
                      ?? deploymentState[analysis.currentDeployment?.deploymentId]
                    }
                    deploymentPending={Boolean(deploymentPending[analysis.deploymentId])}
                    deploymentError={deploymentErrors[analysis.deploymentId]}
                    startDeployment={startDeployment}
                    retryDeployment={retryDeployment}
                    redeployApp={redeployApp}
                    loadDeploymentProgress={loadDeploymentProgress}
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

// The payoff moment: this is the only point in the whole flow where a
// non-technical founder gets proof their app actually exists on the
// internet. A plain line of text buried it. Give it real presence instead:
// a checkmark that draws itself in, and the URL as the headline, not an
// afterthought link below some smaller text.
function LiveReveal({ url }) {
  const [copied, setCopied] = useState(false);
  const displayUrl = url.replace(/^https?:\/\//, "");

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard permission denied or unavailable -- "Open app" still works.
    }
  }

  return (
    <div className="live-reveal">
      <svg className="live-reveal-check" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="11" stroke="currentColor" strokeWidth="2" />
        <path d="M7 12.5l3 3 7-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="live-reveal-body">
        <strong>Your app is live</strong>
        <div className="live-reveal-url-row">
          <a className="live-reveal-url mono" href={url} target="_blank" rel="noreferrer">{displayUrl}</a>
          <button type="button" className="plain live-reveal-copy" onClick={copyUrl}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AnalysisResult({
  analysis,
  configuration,
  secretInputs,
  setSecretInputs,
  saveSecret,
  deployment,
  deploymentPending,
  deploymentError,
  startDeployment,
  retryDeployment,
  redeployApp,
  loadDeploymentProgress,
  isPending,
}) {
  const displayName = {
    nextjs: "Next.js",
    nodejs: "Node.js",
    npm: "npm",
    yarn: "Yarn",
    pnpm: "pnpm",
  };
  const handled = [
    analysis.framework ? `${displayName[analysis.framework] || analysis.framework} app detected` : null,
    analysis.packageManager ? `Using ${displayName[analysis.packageManager] || analysis.packageManager}` : null,
    analysis.buildCommand ? `Build command: ${analysis.buildCommand}` : null,
    analysis.databaseRequired ? "Needs a database" : "No database needed",
  ].filter(Boolean);
  const requirements = configuration?.requirements ?? [];
  const requiredMissing = requirements.filter((item) => item.required && !item.managed && !item.configured);
  const configured = requirements.filter((item) => item.required && !item.managed && item.configured);
  const managed = requirements.filter((item) => item.managed);
  const optional = requirements.filter((item) => !item.required && !item.managed);
  const ready = configuration?.readiness === "READY_TO_DEPLOY";
  // CONFIGURATION_REQUIRED is overloaded server-side: it means "still
  // analysing, don't know the requirements yet" (blockingCode
  // ANALYSIS_REQUIRED) just as much as it means "requirements are known and
  // something's missing." Before analysis finishes, `requirements` is
  // still empty too, so the two lines below used to read "No configuration
  // required." directly above "Waiting on configuration" -- contradictory,
  // and visible in every frame of a deployment recording (caught 2026-10-15
  // reviewing a launch video). Tell them apart so the copy doesn't lie.
  const stillAnalyzing = configuration?.blockingCode === "ANALYSIS_REQUIRED";
  const currentDeployment = deployment ?? analysis.currentDeployment ?? {
    deploymentId: analysis.deploymentId,
    appId: analysis.appId,
    status: analysis.status,
    stage: stageLabelForStatus(analysis.status),
    active: false,
    terminal: terminalDeploymentStatus(analysis.status),
    liveUrl: null,
    events: [],
    diagnostic: null,
  };
  const active = Boolean(currentDeployment.active);
  const live = currentDeployment.status === "LIVE";
  const failed = currentDeployment.status === "FAILED";
  const retryLimitReached = Boolean(currentDeployment.retry?.limitReached);

  useEffect(() => {
    if (!active || !currentDeployment.appId || !currentDeployment.deploymentId) return undefined;
    let cancelled = false;
    let timer = null;

    async function poll() {
      const progress = await loadDeploymentProgress(currentDeployment.appId, currentDeployment.deploymentId, {
        silent: true,
        autoResume: true,
      });
      if (cancelled) return;
      if (progress?.active) {
        timer = setTimeout(poll, 2000);
      }
    }

    timer = setTimeout(poll, deployment ? 2000 : 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, currentDeployment.appId, currentDeployment.deploymentId, deployment?.status]);

  // Once an app is live and nothing is running, the analysis notes and the
  // step tracker are history: show only the live link and Redeploy, with
  // the rest one click away under "Deployment details" (Kiran, 2026-10-20:
  // "once a project is deployed, we don't need to show what happened").
  const settled = live && !active;
  const summarySections = (
    <>
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
            {analysis.errorCode ? <small>{friendlyErrorMessage(analysis.errorCode, "This repository isn't supported yet.")}</small> : null}
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
          {requirements.length || stillAnalyzing ? null : <small>No configuration required.</small>}
          {optional.map((item) => <small key={item.envKey}>{item.envKey} detected, optional / not blocking</small>)}
          <small>{ready ? "Ready to deploy" : stillAnalyzing ? "Still analysing — requirements aren't known yet" : readinessLabel(configuration?.readiness)}</small>
        </div>
    </>
  );
  const progressSections = (
    <>
      <div>
        <strong>Deployment</strong>
        <small>{currentDeployment.stage}</small>
      </div>
      {!failed ? <DeployTracker status={currentDeployment.status} /> : null}
      {currentDeployment.events?.length ? (
        <div className="deployment-log">
          {currentDeployment.events.slice(-2).map((event) => (
            <small key={event.id}>{event.title}</small>
          ))}
        </div>
      ) : null}
    </>
  );

  if (settled) {
    return (
      <div className="analysis-result settled">
        {currentDeployment.liveUrl ? <LiveReveal url={currentDeployment.liveUrl} /> : null}
        <div className="settled-actions">
          <button
            type="button"
            onClick={() => redeployApp(currentDeployment.appId, analysis.deploymentId)}
            disabled={isPending || deploymentPending}
          >
            {deploymentPending ? "Starting..." : "Redeploy"}
          </button>
          <small className="muted">
            {analysis.branch} · {analysis.shortCommitSha || "pending"}
          </small>
        </div>
        {deploymentError ? <small role="status">{deploymentError}</small> : null}
        <details className="deployment-details">
          <summary>Deployment details</summary>
          <div className="deployment-details-body">
            {summarySections}
            <div className="deployment-state">{progressSections}</div>
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="analysis-result">
      {summarySections}
      <div className="deployment-state">
        <div>
          <strong>Deployment</strong>
          <small>{currentDeployment.stage}</small>
        </div>
        {!failed ? <DeployTracker status={currentDeployment.status} /> : null}
        {failed && currentDeployment.diagnostic ? (
          <div className="deploy-failure">
            <span className="deploy-failure-icon" aria-hidden="true">!</span>
            <div>
              <strong>{currentDeployment.diagnostic.title}</strong>
              <small>{currentDeployment.diagnostic.action}</small>
            </div>
          </div>
        ) : null}
        {currentDeployment.events?.length ? (
          <div className="deployment-log">
            {currentDeployment.events.slice(-2).map((event) => (
              <small key={event.id}>{event.title}</small>
            ))}
          </div>
        ) : null}
        {live && currentDeployment.liveUrl ? <LiveReveal url={currentDeployment.liveUrl} /> : null}
        {failed && retryLimitReached ? (
          <small role="status">This deployment has been retried enough times without success. Review what went wrong before trying again.</small>
        ) : null}
        {failed && !retryLimitReached ? (
          <button
            type="button"
            onClick={() => retryDeployment(currentDeployment.appId, currentDeployment.deploymentId, analysis.deploymentId)}
            disabled={isPending || deploymentPending}
          >
            {deploymentPending ? "Starting..." : "Deploy again"}
          </button>
        ) : null}
        {live ? (
          <button
            type="button"
            onClick={() => redeployApp(currentDeployment.appId, analysis.deploymentId)}
            disabled={isPending || deploymentPending}
          >
            {deploymentPending ? "Starting..." : "Redeploy"}
          </button>
        ) : null}
        {live && deploymentError ? <small role="status">{deploymentError}</small> : null}
        {ready && !active && !live && !failed ? (
          <button
            type="button"
            onClick={() => startDeployment(analysis.appId, analysis.deploymentId)}
            disabled={isPending || deploymentPending}
          >
            {deploymentPending ? "Starting..." : "Deploy"}
          </button>
        ) : null}
        {active ? <small role="status">Deployment is running...</small> : null}
      </div>
    </div>
  );
}

function terminalDeploymentStatus(status) {
  return ["LIVE", "FAILED", "DELETED"].includes(status);
}

// Shows the deployment's real pipeline position as a step-by-step tracker.
// Every marker reflects the deployment's actual current status — nothing
// here is guessed or simulated, so a status outside the known pipeline
// order (FAILED, DELETING, DELETED) renders nothing rather than a wrong
// step. The caller is responsible for showing failure state separately.
function DeployTracker({ status }) {
  const order = deploymentStageOrder();
  const currentIndex = deploymentStageIndex(status);
  if (currentIndex === -1) return null;
  const isLive = status === "LIVE";
  return (
    <div
      className="deploy-tracker"
      role="status"
      aria-label={`Deployment progress: ${deploymentStageTrackerLabel(status)}`}
    >
      {order.map((stage, index) => {
        const done = isLive || index < currentIndex;
        const current = !isLive && index === currentIndex;
        const state = done ? "done" : current ? "current" : "pending";
        return (
          <div className={`deploy-step ${state}`} key={stage}>
            <span className="deploy-marker" aria-hidden="true">{done ? "✓" : ""}</span>
            <span className="deploy-step-label">{deploymentStageTrackerLabel(stage)}</span>
          </div>
        );
      })}
    </div>
  );
}
