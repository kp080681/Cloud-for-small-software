export function sscDeploymentMeta({ deploymentId, sourceCommitSha, manifestSha256 }) {
  return {
    sscDeploymentId: deploymentId,
    sscSourceCommitSha: sourceCommitSha,
    ...(manifestSha256 ? { sscManifestSha256: manifestSha256 } : {}),
  };
}

export function sscBuildOperationKey({ deploymentId, sourceCommitSha }) {
  return `vercel:deployment:${deploymentId}:${sourceCommitSha}`;
}

function deploymentMeta(deployment) {
  return deployment?.meta && typeof deployment.meta === "object" ? deployment.meta : {};
}

export function matchesSscDeploymentIdentity(deployment, { deploymentId, sourceCommitSha }) {
  const meta = deploymentMeta(deployment);
  return meta.sscDeploymentId === deploymentId && meta.sscSourceCommitSha === sourceCommitSha;
}

export function matchingSscDeployments(deployments, identity) {
  return deployments.filter((deployment) => matchesSscDeploymentIdentity(deployment, identity));
}

export function classifyProviderDeploymentMatches(matches) {
  if (matches.length === 0) return { status: "none", deployment: null };
  if (matches.length === 1) return { status: "single", deployment: matches[0] };
  return { status: "ambiguous", deployment: null, count: matches.length };
}

export function buildRecoveryAction({ matches, operationStatus }) {
  if (operationStatus === "AMBIGUOUS") {
    return { action: "ambiguous", count: matches.length };
  }
  const matchResult = classifyProviderDeploymentMatches(matches);
  if (matchResult.status === "ambiguous") {
    return { action: "ambiguous", count: matchResult.count };
  }
  if (matchResult.status === "single") {
    return { action: "attach", deployment: matchResult.deployment };
  }
  if (operationStatus === "CREATE_REQUESTED") {
    return { action: "pending" };
  }
  return { action: "create" };
}

export function providerDeploymentUrl(deployment) {
  return deployment?.url ? `https://${deployment.url}` : null;
}
