export const DiagnosticSeverity = Object.freeze({
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
  WARNING: "WARNING",
  NONE: "NONE",
});

export const DiagnosticStage = Object.freeze({
  ANALYSIS: "ANALYSIS",
  ENVIRONMENT: "ENVIRONMENT",
  PROVISIONING: "PROVISIONING",
  BUILD: "BUILD",
  HEALTH: "HEALTH",
  PUBLIC_ACCESS: "PUBLIC_ACCESS",
  POLICY: "POLICY",
  UNKNOWN: "UNKNOWN",
});

const terminalStatuses = new Set(["LIVE", "FAILED", "DELETED"]);

function diagnostic({ severity, stage, code, title, explanation, action, retryable = false, evidence = {} }) {
  return {
    severity,
    stage,
    code,
    title,
    explanation,
    action,
    retryable,
    evidence: safeEvidence(evidence),
  };
}

function pickDefined(entries) {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

function eventMetadata(event) {
  return event?.metadata && typeof event.metadata === "object" ? event.metadata : {};
}

function eventAt(event) {
  const value = event?.createdAt ?? event?.created_at ?? null;
  return value ? new Date(value).getTime() : 0;
}

function latestEvent(events, eventType) {
  return [...(events ?? [])]
    .filter((event) => event.eventType === eventType || event.event_type === eventType)
    .sort((a, b) => eventAt(b) - eventAt(a))[0] ?? null;
}

function latestRemoteContainmentEvent(events) {
  return [...(events ?? [])]
    .filter((event) => [
      "PROVIDER_CANCEL_CONFIRMED",
      "PROVIDER_ALREADY_TERMINAL",
      "PROVIDER_CANCEL_FAILED",
    ].includes(event.eventType ?? event.event_type))
    .sort((a, b) => eventAt(b) - eventAt(a))[0] ?? null;
}

function publicAccessStillBlocked(context) {
  const blocked = latestEvent(context.events, "PUBLIC_ACCESS_BLOCKED");
  if (!blocked || context.deployment?.status === "LIVE") return null;
  const verified = latestEvent(context.events, "PUBLIC_ACCESS_VERIFIED");
  return !verified || eventAt(blocked) > eventAt(verified) ? blocked : null;
}

function envStillBlocked(context, errorCode) {
  const blocked = latestEvent(context.events, "ENV_REQUIREMENTS_BLOCKED");
  if (errorCode === "ENV_CONFIGURATION_REQUIRED") return blocked;
  if (!blocked || context.deployment?.status !== "ANALYZING") return null;
  const verified = latestEvent(context.events, "ENV_REQUIREMENTS_VERIFIED");
  return !verified || eventAt(blocked) > eventAt(verified) ? blocked : null;
}

function latestProgressionEvent(context, eventTypes) {
  return [...(context.events ?? [])]
    .filter((event) => eventTypes.includes(event.eventType ?? event.event_type))
    .sort((a, b) => eventAt(b) - eventAt(a))[0] ?? null;
}

function policyStillBlocked(context, errorCode) {
  const blocked = latestEvent(context.events, "RESOURCE_POLICY_BLOCKED");
  if (["ENV_VAR_LIMIT_EXCEEDED", "DEPLOYMENT_DAILY_LIMIT_EXCEEDED"].includes(errorCode)) return blocked;
  if (!blocked || context.deployment?.status !== "BUILDING") return null;
  if (context.deployment?.providerDeploymentId || context.build?.providerDeploymentId) return null;
  const progressed = latestProgressionEvent(context, [
    "BUILD_STARTED",
    "BUILD_RECOVERY_ATTACHED",
    "BUILD_SUCCEEDED",
    "BUILD_FAILED",
    "BUILD_TIMEOUT",
    "BUILD_SOURCE_MISMATCH",
  ]);
  return !progressed || eventAt(blocked) > eventAt(progressed) ? blocked : null;
}

function envBlockedEvidence(context, event) {
  const metadata = eventMetadata(event);
  const missingKeys = context.missingEnvKeys ?? metadata.missingKeys ?? [];
  return pickDefined({
    deploymentStatus: context.deployment?.status,
    missingCount: context.missingEnvCount ?? metadata.missingCount ?? missingKeys.length,
    missingKeys,
    requirementCount: context.envRequirementCount ?? metadata.requirementCount,
    snapshotId: context.envSnapshot?.id ?? metadata.snapshotId,
    detectedCount: context.envSnapshot?.detectedCount,
  });
}

function buildEvidence(context, event) {
  const metadata = eventMetadata(event);
  const remoteContainment = metadata.remoteContainment?.remoteContainment ?? metadata.remoteContainment;
  return pickDefined({
    deploymentStatus: context.deployment?.status,
    buildStatus: context.build?.status,
    providerDeploymentId: context.build?.providerDeploymentId ?? metadata.providerDeploymentId,
    providerDeploymentUrl: context.build?.providerDeploymentUrl,
    sourceCommitSha: context.build?.sourceCommitSha ?? context.deployment?.sourceCommitSha ?? metadata.sourceCommitSha,
    expectedCommitSha: metadata.expectedCommitSha,
    observedCommitSha: metadata.observedCommitSha,
    sourceIdentityMatches: metadata.sourceIdentityMatches,
    maxBuildMinutes: metadata.maxBuildMinutes ?? context.policy?.maxBuildMinutes,
    buildLogCount: context.buildLogCount,
    buildErrorLogCount: context.buildErrorLogCount,
    providerOperationStatus: context.providerOperation?.status,
    providerOperationType: context.providerOperation?.operationType,
    providerOperationId: context.providerOperation?.id,
    remoteContainment,
  });
}

function healthEvidence(context, event) {
  const metadata = eventMetadata(event);
  const last = context.lastHealthCheck ?? {};
  return pickDefined({
    deploymentStatus: context.deployment?.status,
    attempts: metadata.attempts ?? context.healthAttemptCount,
    maxAttempts: context.policy?.maxHealthAttempts,
    attemptNumber: metadata.attemptNumber ?? last.attemptNumber,
    lastStatus: last.status,
    lastHttpStatus: metadata.httpStatus ?? last.httpStatus,
    lastLatencyMs: metadata.latencyMs ?? last.latencyMs,
    lastErrorCode: metadata.errorCode ?? last.errorCode,
    responseBodyStored: metadata.responseBodyStored ?? false,
  });
}

function publicAccessEvidence(context, event) {
  const metadata = eventMetadata(event);
  return pickDefined({
    deploymentStatus: context.deployment?.status,
    providerDeploymentId: context.build?.providerDeploymentId ?? metadata.providerDeploymentId,
    checkUrl: metadata.checkUrl,
    httpStatus: metadata.httpStatus,
    latencyMs: metadata.latencyMs,
    redirectLocationHost: metadata.redirectLocationHost,
    vercelAuthRedirect: metadata.vercelAuthRedirect,
    responseBodyStored: metadata.responseBodyStored ?? false,
  });
}

function policyEvidence(context, event) {
  const metadata = eventMetadata(event);
  return pickDefined({
    deploymentStatus: context.deployment?.status,
    policyTier: metadata.policyTier ?? context.policy?.policyTier,
    violations: Array.isArray(metadata.violations)
      ? metadata.violations.map((violation) => pickDefined({
        code: violation.code,
        message: violation.message,
      }))
      : undefined,
  });
}

function providerBlockEvidence(context, event) {
  const metadata = eventMetadata(event);
  return pickDefined({
    deploymentStatus: context.deployment?.status,
    provider: metadata.provider ?? context.providerOperation?.provider,
    classification: metadata.classification,
    providerOperationId: metadata.providerOperationId ?? context.providerOperation?.id,
    providerOperationStatus: context.providerOperation?.status,
    sourceCommitSha: context.deployment?.sourceCommitSha ?? context.providerOperation?.sourceCommitSha,
  });
}

function unknownEvidence(context) {
  const containment = eventMetadata(latestRemoteContainmentEvent(context.events));
  return pickDefined({
    deploymentStatus: context.deployment?.status,
    errorCode: context.deployment?.errorCode,
    latestEventType: context.events?.[0]?.eventType,
    providerDeploymentId: context.build?.providerDeploymentId ?? context.deployment?.providerDeploymentId,
    sourceCommitSha: context.deployment?.sourceCommitSha,
    remoteContainment: containment.remoteContainment,
    remoteContainmentRetryable: containment.retryable,
  });
}

function safeEvidence(value) {
  if (Array.isArray(value)) return value.map(safeEvidence);
  if (!value || typeof value !== "object") return value;
  const blocked = /secret|token|credential|authorization|ciphertext|privateKey|providerBody|rawLog/i;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !blocked.test(key))
    .map(([key, item]) => [key, safeEvidence(item)]));
}

export function normalizeDeploymentDiagnostic(context) {
  const deployment = context.deployment ?? {};
  const errorCode = deployment.errorCode ?? null;
  const envBlocked = envStillBlocked(context, errorCode);
  const policyBlocked = policyStillBlocked(context, errorCode);
  const publicAccessBlocked = publicAccessStillBlocked(context);

  if (errorCode === "ENV_CONFIGURATION_REQUIRED" || envBlocked) {
    return diagnostic({
      severity: DiagnosticSeverity.BLOCKED,
      stage: DiagnosticStage.ENVIRONMENT,
      code: "ENV_CONFIGURATION_REQUIRED",
      title: "Required environment configuration is missing",
      explanation: "This deployment is still in analysis because SSC knows required runtime variables are not configured for production.",
      action: "Configure the missing required variables in SSC, then replay the deployment from analysis.",
      retryable: true,
      evidence: envBlockedEvidence(context, envBlocked),
    });
  }

  if (["ENV_VAR_LIMIT_EXCEEDED", "DEPLOYMENT_DAILY_LIMIT_EXCEEDED"].includes(errorCode) || policyBlocked) {
    return diagnostic({
      severity: DiagnosticSeverity.BLOCKED,
      stage: DiagnosticStage.POLICY,
      code: errorCode ?? "RESOURCE_POLICY_BLOCKED",
      title: "Deployment is blocked by resource policy",
      explanation: "SSC stopped before provider build execution because the deployment exceeded the configured application policy.",
      action: "Review the policy violation and adjust the app configuration or deployment cadence before retrying.",
      retryable: false,
      evidence: policyEvidence(context, policyBlocked),
    });
  }

  if (["VERCEL_DAILY_DEPLOYMENT_QUOTA", "VERCEL_RATE_LIMIT", "VERCEL_AUTH"].includes(errorCode)) {
    const retryable = errorCode === "VERCEL_RATE_LIMIT";
    return diagnostic({
      severity: DiagnosticSeverity.BLOCKED,
      stage: DiagnosticStage.BUILD,
      code: errorCode,
      title: "Deployment provider blocked build creation",
      explanation: "SSC could not create the provider deployment, so no build should be assumed to exist unless provider-operation recovery later observes one.",
      action: retryable
        ? "Retry after the provider rate limit clears."
        : "Resolve the provider quota or authorization problem before retrying.",
      retryable,
      evidence: providerBlockEvidence(context, latestEvent(context.events, "BUILD_PROVIDER_BLOCKED")),
    });
  }

  if (errorCode === "BUILD_TIMEOUT") {
    return diagnostic({
      severity: DiagnosticSeverity.FAILED,
      stage: DiagnosticStage.BUILD,
      code: "BUILD_TIMEOUT",
      title: "Build exceeded the configured time limit",
      explanation: "The provider build did not complete before SSC's build-duration policy deadline.",
      action: "Review the stored build logs, build command, dependency installation time, and build-duration policy before redeploying.",
      retryable: true,
      evidence: buildEvidence(context, latestEvent(context.events, "BUILD_TIMEOUT")),
    });
  }

  if (errorCode === "BUILD_SOURCE_MISMATCH") {
    return diagnostic({
      severity: DiagnosticSeverity.FAILED,
      stage: DiagnosticStage.BUILD,
      code: "BUILD_SOURCE_MISMATCH",
      title: "Provider build source did not match the immutable deployment source",
      explanation: "SSC rejected the provider build because the observed source identity differed from the frozen deployment commit.",
      action: "Do not reuse this provider build. Start a new deployment from the intended source commit after confirming repository and provider metadata.",
      retryable: false,
      evidence: buildEvidence(context, latestEvent(context.events, "BUILD_SOURCE_MISMATCH")),
    });
  }

  if (errorCode === "BUILD_FAILED") {
    return diagnostic({
      severity: DiagnosticSeverity.FAILED,
      stage: DiagnosticStage.BUILD,
      code: "BUILD_FAILED",
      title: "Provider build failed",
      explanation: "The application build reached the provider but did not complete successfully.",
      action: "Inspect the stored build logs and fix the application build or build command before redeploying.",
      retryable: true,
      evidence: buildEvidence(context, latestEvent(context.events, "BUILD_FAILED")),
    });
  }

  if (errorCode === "HEALTH_CHECK_FAILED") {
    return diagnostic({
      severity: DiagnosticSeverity.FAILED,
      stage: DiagnosticStage.HEALTH,
      code: "HEALTH_CHECK_FAILED",
      title: "Application did not become healthy",
      explanation: "The provider build completed, but the deployed application did not pass SSC readiness checks.",
      action: "Review application startup behavior, runtime environment, and the last safe health-check status before redeploying.",
      retryable: true,
      evidence: healthEvidence(context, latestEvent(context.events, "HEALTH_CHECK_FAILED")),
    });
  }

  if (publicAccessBlocked) {
    return diagnostic({
      severity: DiagnosticSeverity.BLOCKED,
      stage: DiagnosticStage.PUBLIC_ACCESS,
      code: "PUBLIC_ACCESS_BLOCKED",
      title: "Anonymous public HTTPS access is blocked",
      explanation: "The build and health check succeeded, but SSC could not verify anonymous access to the production URL.",
      action: "Check provider deployment protection and public access settings, then replay public verification.",
      retryable: true,
      evidence: publicAccessEvidence(context, publicAccessBlocked),
    });
  }

  if (deployment.status === "LIVE") {
    return diagnostic({
      severity: DiagnosticSeverity.NONE,
      stage: DiagnosticStage.UNKNOWN,
      code: "DEPLOYMENT_LIVE",
      title: "Deployment is live",
      explanation: "SSC has verified the deployment and anonymous public HTTPS access.",
      action: "No action required.",
      retryable: false,
      evidence: pickDefined({
        deploymentStatus: deployment.status,
        liveUrl: deployment.liveUrl,
        providerDeploymentId: context.build?.providerDeploymentId ?? deployment.providerDeploymentId,
        sourceCommitSha: deployment.sourceCommitSha,
      }),
    });
  }

  if (deployment.status === "FAILED" || errorCode) {
    return diagnostic({
      severity: deployment.status === "FAILED" ? DiagnosticSeverity.FAILED : DiagnosticSeverity.WARNING,
      stage: DiagnosticStage.UNKNOWN,
      code: errorCode ?? "UNKNOWN",
      title: "Deployment has an unrecognized diagnostic code",
      explanation: "SSC does not yet have a specific diagnostic template for this persisted deployment code.",
      action: "Inspect the latest deployment events and worker history before retrying.",
      retryable: false,
      evidence: unknownEvidence(context),
    });
  }

  return diagnostic({
    severity: DiagnosticSeverity.NONE,
    stage: stageForStatus(deployment.status),
    code: "NO_CURRENT_ISSUE",
    title: "No current deployment issue",
    explanation: terminalStatuses.has(deployment.status)
      ? "SSC has no active diagnostic issue for this terminal deployment."
      : "The deployment is in progress and SSC has not recorded a blocking or failed condition.",
    action: "No action required.",
    retryable: false,
    evidence: unknownEvidence(context),
  });
}

function stageForStatus(status) {
  if (status === "ANALYZING") return DiagnosticStage.ANALYSIS;
  if (status === "PROVISIONING") return DiagnosticStage.PROVISIONING;
  if (status === "BUILDING" || status === "DEPLOYING") return DiagnosticStage.BUILD;
  if (status === "HEALTH_CHECKING") return DiagnosticStage.HEALTH;
  return DiagnosticStage.UNKNOWN;
}
