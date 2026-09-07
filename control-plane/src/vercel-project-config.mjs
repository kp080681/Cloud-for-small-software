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

export function gitAutoDeploymentState(project) {
  if (
    project &&
    Object.hasOwn(project, "git") &&
    Object.hasOwn(project, "link") &&
    project.git == null &&
    project.link == null
  ) {
    return "disconnected";
  }
  if (project?.link || project?.git) return "connected";
  return "unknown";
}

export function gitAutoDeploymentsDisabled(project) {
  return gitAutoDeploymentState(project) === "disconnected";
}

export async function ensureGitAutoDeploymentsDisabled({
  project,
  projectId = project?.id,
} = {}) {
  const initialState = gitAutoDeploymentState(project);
  if (gitAutoDeploymentsDisabled(project)) {
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
