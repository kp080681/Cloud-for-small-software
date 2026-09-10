export const GitAutoDeployContainment = Object.freeze({
  DISCONNECTED: "GIT_AUTODEPLOY_DISCONNECTED",
  ALREADY_DISCONNECTED: "GIT_AUTODEPLOY_ALREADY_DISCONNECTED",
  ACTION_REQUIRED: "GIT_AUTODEPLOY_DISCONNECT_REQUIRED",
  UNKNOWN: "GIT_AUTODEPLOY_STATE_UNKNOWN",
});

export function sscManagedProjectGitSettings() {
  return {
    skipGitConnectDuringLink: true,
  };
}

function hasOwn(object, key) {
  return Object.hasOwn(object, key);
}

function isTrustedVercelProjectResponse(project, trustedVercelProjectResponse) {
  return trustedVercelProjectResponse === true
    && project
    && typeof project.id === "string"
    && typeof project.name === "string";
}

export function gitAutoDeploymentState(project, {
  trustedVercelProjectResponse = false,
} = {}) {
  if (!project || typeof project !== "object") return "unknown";
  if (project.link || project.git || project.gitRepository) return "connected";
  if (
    hasOwn(project, "git") &&
    hasOwn(project, "link") &&
    project.git == null &&
    project.link == null
  ) {
    return "disconnected";
  }
  if (
    isTrustedVercelProjectResponse(project, trustedVercelProjectResponse) &&
    (!hasOwn(project, "git") || project.git == null) &&
    (!hasOwn(project, "link") || project.link == null) &&
    (!hasOwn(project, "gitRepository") || project.gitRepository == null)
  ) {
    return "disconnected";
  }
  return "unknown";
}

export function gitAutoDeploymentsDisabled(project, options = {}) {
  return gitAutoDeploymentState(project, options) === "disconnected";
}

export async function ensureGitAutoDeploymentsDisabled({
  project,
  projectId = project?.id,
  trustedVercelProjectResponse = false,
} = {}) {
  const initialState = gitAutoDeploymentState(project, { trustedVercelProjectResponse });
  if (gitAutoDeploymentsDisabled(project, { trustedVercelProjectResponse })) {
    return {
      ok: true,
      result: GitAutoDeployContainment.ALREADY_DISCONNECTED,
      state: initialState,
      corrected: false,
    };
  }

  if (initialState === "connected") {
    return {
      ok: false,
      result: GitAutoDeployContainment.ACTION_REQUIRED,
      state: initialState,
      corrected: false,
      projectId: projectId ?? null,
      reason: "connected-git-requires-manual-disconnect",
    };
  }

  return {
    ok: false,
    result: GitAutoDeployContainment.UNKNOWN,
    state: initialState,
    corrected: false,
    projectId: projectId ?? null,
    reason: "provider-git-state-unavailable",
  };
}
