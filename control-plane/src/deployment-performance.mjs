const LIVE_EVENT = "PUBLIC_ACCESS_VERIFIED";

function toMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function diffMs(start, end) {
  const startMs = toMs(start);
  const endMs = toMs(end);
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return endMs - startMs;
}

function sortedEvents(events = []) {
  return [...events].sort((a, b) => {
    const aTime = toMs(a.createdAt ?? a.created_at) ?? 0;
    const bTime = toMs(b.createdAt ?? b.created_at) ?? 0;
    const aId = Number(a.id ?? 0);
    const bId = Number(b.id ?? 0);
    return aTime - bTime || aId - bId;
  });
}

function eventType(event) {
  return event?.eventType ?? event?.event_type ?? null;
}

function eventAt(event) {
  return event?.createdAt ?? event?.created_at ?? null;
}

function firstEvent(events, type) {
  return sortedEvents(events).find((event) => eventType(event) === type) ?? null;
}

function firstTransition(events, fromStatus, toStatus) {
  return sortedEvents(events).find((event) => (
    (event.fromStatus ?? event.from_status) === fromStatus &&
    (event.toStatus ?? event.to_status) === toStatus
  )) ?? null;
}

function firstOf(events, types) {
  return sortedEvents(events).find((event) => types.includes(eventType(event))) ?? null;
}

function sumKnown(values) {
  const known = values.filter((value) => typeof value === "number");
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

export function normalizeDeploymentPerformance(context) {
  const deployment = context.deployment ?? {};
  const events = sortedEvents(context.events);

  const queued = deployment.queuedAt ?? eventAt(firstTransition(events, "READY", "QUEUED"));
  const analysisStarted = deployment.startedAt ?? eventAt(firstEvent(events, "ANALYSIS_STARTED")) ?? eventAt(firstTransition(events, "QUEUED", "ANALYZING"));
  const analysisFinished = eventAt(firstEvent(events, "ENV_REQUIREMENTS_VERIFIED")) ?? eventAt(firstTransition(events, "ANALYZING", "PROVISIONING"));
  const provisioningFinished = eventAt(firstOf(events, ["RUNTIME_PROVISIONED", "RUNTIME_RECONCILED"])) ?? eventAt(firstTransition(events, "PROVISIONING", "BUILDING"));
  const buildStarted = eventAt(firstEvent(events, "BUILD_STARTED"));
  const buildFinished = eventAt(firstOf(events, ["BUILD_SUCCEEDED", "BUILD_FAILED", "BUILD_TIMEOUT", "BUILD_SOURCE_MISMATCH"]));
  const healthStarted = eventAt(firstEvent(events, "HEALTH_CHECK_STARTED")) ?? eventAt(firstTransition(events, "DEPLOYING", "HEALTH_CHECKING"));
  const healthFinished = eventAt(firstOf(events, ["HEALTH_CHECK_PASSED", "HEALTH_CHECK_FAILED"]));
  const publicAccessFinished = eventAt(firstOf(events, [LIVE_EVENT, "PUBLIC_ACCESS_BLOCKED"]));
  const finished = deployment.finishedAt ?? publicAccessFinished;

  const queueLatencyMs = diffMs(queued, analysisStarted);
  const analysisDurationMs = diffMs(analysisStarted, analysisFinished);
  const provisioningDurationMs = diffMs(analysisFinished, provisioningFinished);
  const buildDurationMs = diffMs(buildStarted, buildFinished);
  const healthDurationMs = diffMs(healthStarted, healthFinished);
  const publicAccessDurationMs = diffMs(healthFinished, publicAccessFinished);
  const providerDominatedDurationMs = sumKnown([provisioningDurationMs, buildDurationMs]);
  const controlPlaneObservedDurationMs = sumKnown([queueLatencyMs, analysisDurationMs, healthDurationMs, publicAccessDurationMs]);

  return {
    deploymentId: deployment.id ?? null,
    appSlug: deployment.appSlug ?? null,
    totalDurationMs: diffMs(queued ?? deployment.createdAt, finished),
    queueLatencyMs,
    analysisDurationMs,
    provisioningDurationMs,
    buildDurationMs,
    healthDurationMs,
    publicAccessDurationMs,
    providerDominatedDurationMs,
    controlPlaneObservedDurationMs,
  };
}

export function summarizeReadTimings(samples) {
  const sorted = samples
    .map((sample) => Number(sample.durationMs))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, p50Ms: null, maxMs: null };
  return {
    count: sorted.length,
    p50Ms: sorted[Math.floor((sorted.length - 1) / 2)],
    maxMs: sorted.at(-1),
  };
}
