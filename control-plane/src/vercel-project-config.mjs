export const GitAutoDeployContainment = Object.freeze({
  DISABLED: "GIT_AUTODEPLOY_DISABLED",
  ALREADY_DISABLED: "GIT_AUTODEPLOY_ALREADY_DISABLED",
  CORRECTED: "GIT_AUTODEPLOY_CORRECTED",
  VERIFICATION_FAILED: "GIT_AUTODEPLOY_VERIFICATION_FAILED",
  PROVIDER_UNSUPPORTED: "GIT_AUTODEPLOY_PROVIDER_UNSUPPORTED",
});

export function sscManagedProjectGitSettings() {
  return {
    skipGitConnectDuringLink: true,
  };
}

export function disableGitAutoDeploymentsBody() {
  return {
    git: {
      deploymentEnabled: false,
    },
  };
}

export function gitAutoDeploymentState(project) {
  if (project?.git?.deploymentEnabled === false) return "disabled";
  if (project?.git?.deploymentEnabled === true) return "enabled";
  if (
    project &&
    Object.hasOwn(project, "git") &&
    Object.hasOwn(project, "link") &&
    project.git == null &&
    project.link == null
  ) {
    return "disconnected";
  }
  if (project?.link || project?.git) return "enabled";
  return "unknown";
}

export function gitAutoDeploymentsDisabled(project) {
  return ["disabled", "disconnected"].includes(gitAutoDeploymentState(project));
}

export async function ensureGitAutoDeploymentsDisabled({
  project,
  projectId = project?.id,
  getProject,
  updateProject,
} = {}) {
  const initialState = gitAutoDeploymentState(project);
  if (gitAutoDeploymentsDisabled(project)) {
    return {
      ok: true,
      result: GitAutoDeployContainment.ALREADY_DISABLED,
      state: initialState,
      corrected: false,
    };
  }

  if (!projectId || typeof updateProject !== "function" || typeof getProject !== "function") {
    return {
      ok: false,
      result: GitAutoDeployContainment.PROVIDER_UNSUPPORTED,
      state: initialState,
      corrected: false,
      reason: "provider-update-or-refetch-unavailable",
    };
  }

  try {
    await updateProject(projectId, disableGitAutoDeploymentsBody());
  } catch (error) {
    return {
      ok: false,
      result: GitAutoDeployContainment.PROVIDER_UNSUPPORTED,
      state: initialState,
      corrected: false,
      providerHttpStatus: error?.status ?? null,
      reason: "provider-update-failed",
    };
  }

  const verified = await getProject(projectId);
  const verifiedState = gitAutoDeploymentState(verified);
  if (gitAutoDeploymentsDisabled(verified)) {
    return {
      ok: true,
      result: GitAutoDeployContainment.CORRECTED,
      state: verifiedState,
      corrected: true,
    };
  }

  return {
    ok: false,
    result: GitAutoDeployContainment.VERIFICATION_FAILED,
    state: verifiedState,
    corrected: false,
    reason: "provider-state-not-disabled-after-update",
  };
}
