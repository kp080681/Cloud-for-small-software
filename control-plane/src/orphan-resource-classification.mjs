export const OrphanResourceClassification = Object.freeze({
  KNOWN: "KNOWN",
  RECOVERABLE: "RECOVERABLE",
  ORPHAN: "ORPHAN",
  AMBIGUOUS: "AMBIGUOUS",
  FOREIGN_IGNORE: "FOREIGN_IGNORE",
});

function sscMeta(resource) {
  const meta = resource?.meta && typeof resource.meta === "object" ? resource.meta : {};
  const deploymentId = meta.sscDeploymentId;
  const sourceCommitSha = meta.sscSourceCommitSha;
  if (!deploymentId || !sourceCommitSha) return null;
  return {
    deploymentId,
    sourceCommitSha,
    manifestSha256: meta.sscManifestSha256 ?? null,
  };
}

export function sscDeploymentIdentity(resource) {
  const meta = sscMeta(resource);
  if (!meta) return null;
  return `${meta.deploymentId}:${meta.sourceCommitSha}`;
}

export function duplicateSscDeploymentIdentities(resources) {
  const counts = new Map();
  for (const resource of resources) {
    const identity = sscDeploymentIdentity(resource);
    if (!identity) continue;
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([identity]) => identity));
}

export function classifyVercelDeploymentResource(resource, controlPlane, options = {}) {
  const meta = sscMeta(resource);
  if (!meta) {
    return {
      classification: OrphanResourceClassification.FOREIGN_IGNORE,
      reason: "MISSING_SSC_METADATA",
    };
  }

  const identity = `${meta.deploymentId}:${meta.sourceCommitSha}`;
  if (options.ambiguousIdentities?.has(identity)) {
    return {
      classification: OrphanResourceClassification.AMBIGUOUS,
      reason: "DUPLICATE_PROVIDER_RESOURCES_FOR_SSC_IDENTITY",
      deploymentId: meta.deploymentId,
      sourceCommitSha: meta.sourceCommitSha,
    };
  }

  const deployment = controlPlane.deploymentsById.get(meta.deploymentId);
  if (!deployment) {
    return {
      classification: OrphanResourceClassification.ORPHAN,
      reason: "SSC_DEPLOYMENT_NOT_FOUND",
      deploymentId: meta.deploymentId,
      sourceCommitSha: meta.sourceCommitSha,
    };
  }

  if (deployment.sourceCommitSha !== meta.sourceCommitSha) {
    return {
      classification: OrphanResourceClassification.AMBIGUOUS,
      reason: "SSC_METADATA_SOURCE_MISMATCH",
      deploymentId: meta.deploymentId,
      deploymentStatus: deployment.status,
      sourceCommitSha: meta.sourceCommitSha,
      expectedSourceCommitSha: deployment.sourceCommitSha,
    };
  }

  const buildByProviderId = controlPlane.buildsByProviderDeploymentId.get(resource.providerDeploymentId);
  if (buildByProviderId && buildByProviderId.deploymentId !== meta.deploymentId) {
    return {
      classification: OrphanResourceClassification.AMBIGUOUS,
      reason: "PROVIDER_DEPLOYMENT_BOUND_TO_DIFFERENT_DEPLOYMENT",
      deploymentId: meta.deploymentId,
      boundDeploymentId: buildByProviderId.deploymentId,
      deploymentStatus: deployment.status,
      sourceCommitSha: meta.sourceCommitSha,
    };
  }

  const buildByDeploymentId = controlPlane.buildsByDeploymentId.get(meta.deploymentId);
  if (buildByDeploymentId?.providerDeploymentId === resource.providerDeploymentId) {
    return {
      classification: OrphanResourceClassification.KNOWN,
      reason: "PROVIDER_DEPLOYMENT_BOUND_TO_DEPLOYMENT_BUILD",
      deploymentId: meta.deploymentId,
      deploymentStatus: deployment.status,
      sourceCommitSha: meta.sourceCommitSha,
    };
  }

  const operation = controlPlane.operationsByProviderResourceId.get(resource.providerDeploymentId);
  if (operation && operation.deploymentId !== meta.deploymentId) {
    return {
      classification: OrphanResourceClassification.AMBIGUOUS,
      reason: "PROVIDER_OPERATION_BOUND_TO_DIFFERENT_DEPLOYMENT",
      deploymentId: meta.deploymentId,
      boundDeploymentId: operation.deploymentId,
      deploymentStatus: deployment.status,
      sourceCommitSha: meta.sourceCommitSha,
    };
  }

  return {
    classification: OrphanResourceClassification.RECOVERABLE,
    reason: "SSC_DEPLOYMENT_EXISTS_BUT_PROVIDER_BUILD_BINDING_MISSING",
    deploymentId: meta.deploymentId,
    deploymentStatus: deployment.status,
    sourceCommitSha: meta.sourceCommitSha,
  };
}

export function summarizeClassifications(classifications) {
  const counts = Object.fromEntries(Object.values(OrphanResourceClassification).map((key) => [key, 0]));
  for (const item of classifications) counts[item.classification] += 1;
  return counts;
}
