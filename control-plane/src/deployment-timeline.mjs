const terminalStatuses = new Set(["LIVE", "FAILED", "DELETED"]);

const categoryByPrefix = [
  ["ENV_REQUIREMENTS_", "ENVIRONMENT"],
  ["RUNTIME_", "PROVISIONING"],
  ["BUILD_RECOVERY_", "RECOVERY"],
  ["BUILD_PROVIDER_", "RECOVERY"],
  ["BUILD_", "BUILD"],
  ["HEALTH_CHECK_", "HEALTH"],
  ["PUBLIC_ACCESS_", "PUBLIC_ACCESS"],
  ["RESOURCE_POLICY_", "POLICY"],
  ["DEPLOYMENT_ABANDONED", "RECOVERY"],
  ["APP_DELETION_", "DELETION"],
  ["APP_DELETED", "DELETION"],
];

const eventTemplates = Object.freeze({
  QUEUED: ["LIFECYCLE", "Deployment queued", "SSC accepted the deployment for orchestration."],
  ANALYSIS_STARTED: ["LIFECYCLE", "Analysis started", "SSC began analyzing the deployment source."],
  BUILD_INPUT_PREPARED: ["LIFECYCLE", "Immutable build input prepared", "SSC prepared build input for the frozen source commit."],
  REDEPLOY_CREATED: ["LIFECYCLE", "Redeployment created", "SSC created a redeployment from the current repository head."],
  ENV_REQUIREMENTS_DETECTED: ["ENVIRONMENT", "Environment references detected", "SSC detected environment references from the frozen source commit."],
  ENV_REQUIREMENTS_BLOCKED: ["ENVIRONMENT", "Environment configuration blocked deployment", "Required production environment configuration was missing."],
  ENV_REQUIREMENTS_VERIFIED: ["ENVIRONMENT", "Environment configuration verified", "Required production environment configuration was present."],
  RUNTIME_RECONCILED: ["PROVISIONING", "Runtime reconciled", "SSC found and reused the existing application runtime."],
  RUNTIME_PROVISIONED: ["PROVISIONING", "Runtime provisioned", "SSC provisioned or reconciled the application runtime."],
  RUNTIME_ENV_APPLIED: ["PROVISIONING", "Runtime environment applied", "SSC applied configured runtime environment variables to the provider."],
  RESOURCE_POLICY_BLOCKED: ["POLICY", "Resource policy blocked deployment", "SSC stopped deployment before build execution because a resource policy was exceeded."],
  BUILD_PROVIDER_BLOCKED: ["RECOVERY", "Provider blocked build creation", "The deployment provider rejected or throttled build creation."],
  BUILD_RECOVERY_ATTACHED: ["RECOVERY", "Provider build recovered", "SSC attached an existing provider deployment instead of creating a duplicate."],
  BUILD_STARTED: ["BUILD", "Provider build started", "SSC requested a provider build for the immutable source commit."],
  BUILD_SUCCEEDED: ["BUILD", "Provider build succeeded", "The provider build completed successfully."],
  BUILD_FAILED: ["BUILD", "Provider build failed", "The provider build did not complete successfully."],
  BUILD_TIMEOUT: ["BUILD", "Build timed out", "The provider build exceeded SSC's configured build-duration policy."],
  BUILD_SOURCE_MISMATCH: ["BUILD", "Build source mismatch", "SSC rejected the provider build because source identity did not match the immutable deployment source."],
  BUILD_LOGS_INGESTED: ["BUILD", "Build logs ingested", "SSC stored a bounded, redacted build-log sample for diagnostics."],
  HEALTH_CHECK_STARTED: ["HEALTH", "Health checks started", "SSC began readiness checks for the provider deployment."],
  HEALTH_CHECK_PASSED: ["HEALTH", "Health check passed", "The deployment passed a readiness check."],
  HEALTH_CHECK_FAILED: ["HEALTH", "Health checks failed", "The deployment exhausted readiness checks without becoming healthy."],
  PUBLIC_ACCESS_BLOCKED: ["PUBLIC_ACCESS", "Public access blocked", "SSC could not verify anonymous HTTPS access to the production URL."],
  PUBLIC_ACCESS_VERIFIED: ["PUBLIC_ACCESS", "Public access verified", "SSC verified anonymous HTTPS access to the production URL."],
  DEPLOYMENT_ABANDONED: ["RECOVERY", "Deployment abandoned", "SSC explicitly abandoned this deployment."],
  APP_DELETION_STARTED: ["DELETION", "App deletion started", "SSC started application deletion."],
  APP_DELETED: ["DELETION", "App deleted", "SSC completed application deletion."],
});

const safeEvidenceKeys = new Set([
  "allowed",
  "attemptNumber",
  "attempts",
  "attemptsRemaining",
  "branch",
  "buildLogCount",
  "checkUrl",
  "classification",
  "configuredCount",
  "created",
  "detectedCount",
  "errorCode",
  "expectedCommitSha",
  "exhaustedBeforeNextAttempt",
  "fetchedCount",
  "httpStatus",
  "latencyMs",
  "manifestSha256",
  "matchingDeploymentCount",
  "maxAttempts",
  "maxBuildMinutes",
  "missingCount",
  "missingKeys",
  "observedCommitSha",
  "parentDeploymentId",
  "policyTier",
  "previousCommitSha",
  "provider",
  "providerDeploymentId",
  "providerDeploymentUrl",
  "providerOperationId",
  "providerProjectId",
  "providerProjectName",
  "providerStatus",
  "readyState",
  "reconciled",
  "reconciliationKey",
  "redirectLocationHost",
  "repository",
  "requirementCount",
  "responseBodyStored",
  "retryableNow",
  "snapshotId",
  "sourceCommitSha",
  "sourceIdentityMatches",
  "storedCount",
  "target",
  "vercelAuthRedirect",
  "violationCodes",
]);

function toTime(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function eventType(event) {
  return event?.eventType ?? event?.event_type ?? "UNKNOWN";
}

function eventId(event) {
  const value = event?.id;
  return value === null || value === undefined ? 0 : Number(value);
}

function eventMetadata(event) {
  return event?.metadata && typeof event.metadata === "object" ? event.metadata : {};
}

function eventTemplate(type) {
  if (eventTemplates[type]) return eventTemplates[type];
  const knownPrefix = categoryByPrefix.find(([prefix]) => type.startsWith(prefix));
  if (knownPrefix) return [knownPrefix[1], titleFromType(type), "SSC recorded a deployment event in this category."];
  if (type === "STATUS_CHANGED") return ["LIFECYCLE", "Deployment status changed", "SSC recorded a deployment status transition."];
  return ["OTHER", "Deployment event recorded", "SSC recorded an event without a specific timeline template."];
}

function titleFromType(type) {
  return String(type).toLowerCase().split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function safeViolationCodes(violations) {
  if (!Array.isArray(violations)) return undefined;
  return violations.map((violation) => violation?.code).filter(Boolean);
}

function safeEvidence(metadata) {
  const blocked = /secret|token|credential|authorization|ciphertext|privateKey|providerBody|rawLog|value/i;
  const normalized = {
    ...metadata,
    violationCodes: safeViolationCodes(metadata.violations),
  };
  const evidence = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (blocked.test(key) || value === undefined) continue;
    if (!safeEvidenceKeys.has(key)) continue;
    evidence[key] = Array.isArray(value) ? value.slice(0, 50) : value;
  }
  return evidence;
}

export function normalizeDeploymentEvents(events = []) {
  return [...events]
    .sort((a, b) => toTime(a.createdAt ?? a.created_at) - toTime(b.createdAt ?? b.created_at) || eventId(a) - eventId(b))
    .map((event, index) => {
      const type = eventType(event);
      const [category, title, detail] = eventTemplate(type);
      return {
        sequence: index + 1,
        at: isoOrNull(event.createdAt ?? event.created_at),
        type,
        category,
        fromStatus: event.fromStatus ?? event.from_status ?? null,
        toStatus: event.toStatus ?? event.to_status ?? null,
        title,
        detail,
        evidence: safeEvidence(eventMetadata(event)),
      };
    });
}

function durationMs(deployment) {
  const started = toTime(deployment?.startedAt ?? deployment?.queuedAt ?? deployment?.createdAt);
  const finished = toTime(deployment?.finishedAt);
  if (!started || !finished || finished < started) return null;
  return finished - started;
}

function transitioned(events, status) {
  return events.some((event) => (event.toStatus ?? event.to_status) === status);
}

export function normalizeDeploymentTimeline(context, diagnostic) {
  const deployment = context.deployment ?? {};
  const timeline = normalizeDeploymentEvents(context.events);
  const reachedProviderBuild = Boolean(context.build?.providerDeploymentId ?? deployment.providerDeploymentId)
    || timeline.some((event) => event.category === "BUILD" || event.type === "BUILD_RECOVERY_ATTACHED");
  const reachedHealthCheck = (context.healthAttemptCount ?? 0) > 0
    || timeline.some((event) => event.category === "HEALTH")
    || ["HEALTH_CHECKING", "LIVE"].includes(deployment.status);

  return {
    deploymentId: deployment.id ?? null,
    app: {
      id: deployment.appId ?? null,
      slug: deployment.appSlug ?? null,
    },
    source: {
      commitSha: deployment.sourceCommitSha ?? null,
      branch: deployment.sourceBranch ?? null,
    },
    currentStatus: deployment.status ?? null,
    startedAt: isoOrNull(deployment.startedAt ?? deployment.queuedAt ?? deployment.createdAt),
    finishedAt: isoOrNull(deployment.finishedAt),
    durationMs: durationMs(deployment),
    timeline,
    diagnostic,
    summary: {
      eventCount: timeline.length,
      stateTransitionCount: timeline.filter((event) => event.fromStatus !== event.toStatus).length,
      healthAttemptCount: context.healthAttemptCount ?? 0,
      buildLogCount: context.buildLogCount ?? 0,
      reachedProviderBuild,
      reachedHealthCheck,
      reachedLive: deployment.status === "LIVE" || transitioned(context.events ?? [], "LIVE"),
      terminal: terminalStatuses.has(deployment.status),
    },
  };
}
