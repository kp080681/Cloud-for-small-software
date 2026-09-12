export const VercelPublicAccessState = Object.freeze({
  DISABLED: "VERCEL_AUTHENTICATION_DISABLED",
  ENABLED: "VERCEL_AUTHENTICATION_ENABLED",
  UNKNOWN: "VERCEL_AUTHENTICATION_STATE_UNKNOWN",
});

function hasOwn(object, key) {
  return Object.hasOwn(object, key);
}

function trustedProject(project, trustedVercelProjectResponse) {
  return trustedVercelProjectResponse === true
    && project
    && typeof project.id === "string"
    && typeof project.name === "string";
}

export function vercelAuthenticationState(project, {
  trustedVercelProjectResponse = false,
} = {}) {
  if (!project || typeof project !== "object") return "unknown";
  if (project.ssoProtection != null) return "enabled";
  if (hasOwn(project, "ssoProtection") && project.ssoProtection == null) return "disabled";
  if (trustedProject(project, trustedVercelProjectResponse)) return "disabled";
  return "unknown";
}

export function vercelAuthenticationDisabled(project, options = {}) {
  return vercelAuthenticationState(project, options) === "disabled";
}

export async function ensureVercelAuthenticationDisabled({
  project,
  projectId = project?.id,
  trustedVercelProjectResponse = false,
  getProject,
  updateProject,
} = {}) {
  const initialState = vercelAuthenticationState(project, { trustedVercelProjectResponse });
  if (initialState === "disabled") {
    return {
      ok: true,
      result: VercelPublicAccessState.DISABLED,
      state: initialState,
      corrected: false,
      projectId: projectId ?? null,
    };
  }

  if (initialState !== "enabled") {
    return {
      ok: false,
      result: VercelPublicAccessState.UNKNOWN,
      state: initialState,
      corrected: false,
      projectId: projectId ?? null,
      reason: "provider-public-access-state-unavailable",
    };
  }

  if (typeof updateProject !== "function") {
    return {
      ok: false,
      result: VercelPublicAccessState.ENABLED,
      state: initialState,
      corrected: false,
      projectId: projectId ?? null,
      reason: "provider-public-access-update-unavailable",
    };
  }

  const updated = await updateProject(projectId, { ssoProtection: null });
  let finalState = vercelAuthenticationState(updated, { trustedVercelProjectResponse: true });
  if (finalState === "unknown" && typeof getProject === "function") {
    finalState = vercelAuthenticationState(await getProject(projectId), { trustedVercelProjectResponse: true });
  }
  if (finalState !== "disabled") {
    return {
      ok: false,
      result: VercelPublicAccessState.UNKNOWN,
      state: finalState,
      corrected: true,
      projectId: projectId ?? null,
      reason: "provider-public-access-update-unverified",
    };
  }

  return {
    ok: true,
    result: VercelPublicAccessState.DISABLED,
    state: finalState,
    corrected: true,
    projectId: projectId ?? null,
  };
}
