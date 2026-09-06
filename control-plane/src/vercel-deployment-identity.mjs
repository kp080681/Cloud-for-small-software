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

export function providerObservedSourceSha(deployment) {
  return normalizeSha(deployment?.meta?.githubCommitSha)
    ?? normalizeSha(deployment?.gitSource?.sha)
    ?? normalizeSha(deployment?.gitSource?.ref)
    ?? null;
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
