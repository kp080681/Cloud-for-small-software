const MAX_VERCEL_PROJECT_NAME_LENGTH = 80;

export function sanitizedProjectSlug(slug) {
  return String(slug || "app")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    || "app";
}

export function compactIdentityId(value, label) {
  const compact = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!compact) throw new Error(`${label} is required for provider project identity`);
  return compact.slice(0, 12);
}

export function sscProviderProjectName({ workspaceId, appId, slug }) {
  const prefix = `ssc-${compactIdentityId(workspaceId, "Workspace id")}-${compactIdentityId(appId, "App id")}-`;
  const remaining = Math.max(1, MAX_VERCEL_PROJECT_NAME_LENGTH - prefix.length);
  return `${prefix}${sanitizedProjectSlug(slug).slice(0, remaining).replace(/-+$/g, "") || "app"}`;
}

export function legacySlugProviderProjectName(slug) {
  return `ssc-${sanitizedProjectSlug(slug)}`.slice(0, MAX_VERCEL_PROJECT_NAME_LENGTH).replace(/-+$/g, "");
}

export function providerProjectOwnership({ workspaceId, appId, slug, storedProjectName = null }) {
  const expectedName = sscProviderProjectName({ workspaceId, appId, slug });
  const legacyName = legacySlugProviderProjectName(slug);
  return {
    expectedName,
    legacyName,
    storedProjectName: storedProjectName || null,
  };
}

export function assertProviderProjectNotOwnedByAnotherApp(rows, { appId, providerProjectId }) {
  const conflicting = rows.find((row) => (
    String(row.provider_project_id ?? row.providerProjectId ?? "") === String(providerProjectId)
    && String(row.app_id ?? row.appId ?? "") !== String(appId)
  ));
  if (conflicting) {
    throw new Error("Provider project is already owned by another SSC app");
  }
}

/**
 * @param {object} project
 * @param {{ workspaceId: string, appId: string, slug: string, storedProjectName?: string | null, allowLegacyStoredBinding?: boolean }} expected
 */
export function assertRemoteProjectMatchesSscApp(project, { workspaceId, appId, slug, storedProjectName = null, allowLegacyStoredBinding = false }) {
  if (!project?.id) throw new Error("Provider project identity is unavailable");
  const remoteName = project.name ?? project.projectName ?? null;
  if (!remoteName) throw new Error("Provider project name is unavailable");

  const ownership = providerProjectOwnership({ workspaceId, appId, slug, storedProjectName });
  if (remoteName === ownership.expectedName) return project;

  const storedMatchesRemote = storedProjectName && remoteName === storedProjectName;
  if (allowLegacyStoredBinding && storedMatchesRemote && remoteName === ownership.legacyName) {
    return project;
  }

  throw new Error("Provider project identity does not match SSC app ownership");
}
