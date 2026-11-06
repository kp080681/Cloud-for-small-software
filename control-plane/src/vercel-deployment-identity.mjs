export const SourceIdentityStatus = Object.freeze({
  MATCH: "SOURCE_IDENTITY_MATCH",
  MISMATCH: "SOURCE_IDENTITY_MISMATCH",
  UNAVAILABLE: "SOURCE_IDENTITY_UNAVAILABLE",
});

export const ProviderDeploymentIdentityStatus = Object.freeze({
  MATCH: "PROVIDER_DEPLOYMENT_IDENTITY_MATCH",
  MISMATCH: "PROVIDER_DEPLOYMENT_IDENTITY_MISMATCH",
  UNAVAILABLE: "PROVIDER_DEPLOYMENT_IDENTITY_UNAVAILABLE",
});

export const PublicBindingStatus = Object.freeze({
  MATCH: "PUBLIC_BINDING_MATCH",
  MISMATCH: "PUBLIC_BINDING_MISMATCH",
  UNAVAILABLE: "PUBLIC_BINDING_UNAVAILABLE",
});

const SHA_RE = /^[a-f0-9]{40}$/i;

function stringOrNull(value) {
  return value === null || value === undefined ? null : String(value);
}

function deploymentId(resource) {
  return stringOrNull(resource?.id ?? resource?.uid);
}

function projectId(resource) {
  return stringOrNull(resource?.projectId ?? resource?.project?.id ?? resource?.project?.projectId);
}

function sscDeploymentId(resource) {
  const meta = resource?.meta && typeof resource.meta === "object" ? resource.meta : {};
  return stringOrNull(meta.sscDeploymentId);
}

function normalizeSha(value) {
  const text = stringOrNull(value);
  if (!text || !SHA_RE.test(text)) return null;
  return text.toLowerCase();
}

// File-upload builds (execute-build's fallback, and every uploaded app from
// direct publishing, 2026-11-06) carry no Git metadata: the files were read
// by Utplava's own GitHub App from the deployment's exact frozen Git tree
// and uploaded by the control plane with its own provider credentials.
// For those, and only when the provider deployment has no Git source of its
// own, the commit recorded at upload time is the observed source.
export const FILE_UPLOAD_SOURCE_MARKER = "github-app-tree";

export function fileUploadSourceMeta(commitSha) {
  return { sscSourceUpload: FILE_UPLOAD_SOURCE_MARKER, sscUploadedCommitSha: commitSha };
}

export function providerObservedSourceSha(deployment) {
  const fromGit = normalizeSha(deployment?.meta?.githubCommitSha)
    ?? normalizeSha(deployment?.gitSource?.sha)
    ?? normalizeSha(deployment?.gitSource?.ref)
    ?? null;
  if (fromGit) return fromGit;
  if (!deployment?.gitSource && deployment?.meta?.sscSourceUpload === FILE_UPLOAD_SOURCE_MARKER) {
    return normalizeSha(deployment.meta.sscUploadedCommitSha);
  }
  return null;
}

export function verifyProviderSourceIdentity(deployment, expectedCommitSha) {
  const expected = normalizeSha(expectedCommitSha);
  const observed = providerObservedSourceSha(deployment);
  if (!expected || !observed) {
    return { status: SourceIdentityStatus.UNAVAILABLE, expectedCommitSha: expected, observedCommitSha: observed };
  }
  if (observed !== expected) {
    return { status: SourceIdentityStatus.MISMATCH, expectedCommitSha: expected, observedCommitSha: observed };
  }
  return { status: SourceIdentityStatus.MATCH, expectedCommitSha: expected, observedCommitSha: observed };
}

export function verifyProviderDeploymentIdentity(deployment, expected) {
  const expectedDeploymentId = stringOrNull(expected?.providerDeploymentId);
  const expectedProjectId = stringOrNull(expected?.providerProjectId);
  const expectedSscDeploymentId = stringOrNull(expected?.deploymentId);
  const actualDeploymentId = deploymentId(deployment);
  const actualProjectId = projectId(deployment);
  const actualSscDeploymentId = sscDeploymentId(deployment);

  if (!actualDeploymentId || !actualProjectId || !actualSscDeploymentId) {
    return {
      status: ProviderDeploymentIdentityStatus.UNAVAILABLE,
      providerDeploymentId: actualDeploymentId,
      providerProjectId: actualProjectId,
      sscDeploymentId: actualSscDeploymentId,
    };
  }
  if (
    actualDeploymentId !== expectedDeploymentId
    || actualProjectId !== expectedProjectId
    || actualSscDeploymentId !== expectedSscDeploymentId
  ) {
    return {
      status: ProviderDeploymentIdentityStatus.MISMATCH,
      providerDeploymentId: actualDeploymentId,
      providerProjectId: actualProjectId,
      sscDeploymentId: actualSscDeploymentId,
    };
  }
  return {
    status: ProviderDeploymentIdentityStatus.MATCH,
    providerDeploymentId: actualDeploymentId,
    providerProjectId: actualProjectId,
    sscDeploymentId: actualSscDeploymentId,
  };
}

function aliasDeploymentId(alias) {
  return stringOrNull(alias?.deploymentId ?? alias?.deployment?.id ?? alias?.deployment?.uid);
}

function aliasProjectId(alias) {
  return stringOrNull(alias?.projectId ?? alias?.project?.id);
}

function aliasName(alias) {
  if (typeof alias === "string") return alias;
  return stringOrNull(alias?.alias ?? alias?.domain ?? alias?.hostname);
}

export function deploymentAliasNames(deploymentAliases) {
  const aliases = Array.isArray(deploymentAliases?.aliases)
    ? deploymentAliases.aliases
    : Array.isArray(deploymentAliases)
      ? deploymentAliases
      : [];
  return aliases.map(aliasName).filter(Boolean);
}

export function verifyPublicBinding({ alias, deploymentAliases, canonicalHost, providerDeploymentId, providerProjectId }) {
  const expectedDeploymentId = stringOrNull(providerDeploymentId);
  const expectedProjectId = stringOrNull(providerProjectId);
  const host = stringOrNull(canonicalHost);
  if (!expectedDeploymentId || !expectedProjectId || !host || !alias) {
    return { status: PublicBindingStatus.UNAVAILABLE, canonicalHost: host };
  }

  const actualDeploymentId = aliasDeploymentId(alias);
  const actualProjectId = aliasProjectId(alias);
  const actualAlias = aliasName(alias);
  const names = deploymentAliasNames(deploymentAliases);
  const listedOnDeployment = names.includes(host);

  if (!actualDeploymentId || !actualProjectId || !actualAlias) {
    return {
      status: PublicBindingStatus.UNAVAILABLE,
      canonicalHost: host,
      aliasDeploymentId: actualDeploymentId,
      aliasProjectId: actualProjectId,
      listedOnDeployment,
    };
  }
  if (
    actualDeploymentId !== expectedDeploymentId
    || actualProjectId !== expectedProjectId
    || actualAlias !== host
    || !listedOnDeployment
  ) {
    return {
      status: PublicBindingStatus.MISMATCH,
      canonicalHost: host,
      aliasDeploymentId: actualDeploymentId,
      aliasProjectId: actualProjectId,
      listedOnDeployment,
    };
  }
  return {
    status: PublicBindingStatus.MATCH,
    canonicalHost: host,
    aliasDeploymentId: actualDeploymentId,
    aliasProjectId: actualProjectId,
    listedOnDeployment,
  };
}

export function publicBindingHostCandidates({ providerDeployment, project }) {
  const projectName = stringOrNull(project?.name);
  const aliases = Array.isArray(providerDeployment?.alias)
    ? providerDeployment.alias
    : Array.isArray(providerDeployment?.aliases)
      ? providerDeployment.aliases
      : [];
  const projectDomains = Array.isArray(project?.domains) ? project.domains : [];
  const hosts = [
    ...aliases.map(aliasName),
    ...projectDomains.map(aliasName),
    projectName ? `${projectName}.vercel.app` : null,
  ].filter(Boolean);
  return [...new Set(hosts)];
}
