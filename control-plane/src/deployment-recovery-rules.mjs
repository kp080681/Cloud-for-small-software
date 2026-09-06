const TERMINAL_STATUSES = new Set(["LIVE", "FAILED", "DELETED"]);

export function isRecoveryTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function healthAttemptAction({ existingAttemptCount, maxAttempts }) {
  const attemptNumber = Number(existingAttemptCount) + 1;
  if (attemptNumber > Number(maxAttempts)) {
    return { action: "fail-exhausted", attemptNumber, attempts: Number(maxAttempts) };
  }
  return { action: "attempt", attemptNumber, attemptsRemaining: Number(maxAttempts) - attemptNumber };
}

export function buildReconciliationAction({ deploymentStatus, providerStatus, sourceIdentityStatus = "SOURCE_IDENTITY_MATCH" }) {
  if (isRecoveryTerminalStatus(deploymentStatus)) return { action: "terminal-noop" };
  if (providerStatus === "READY" && deploymentStatus === "BUILDING" && sourceIdentityStatus !== "SOURCE_IDENTITY_MATCH") return { action: "source-unverified" };
  if (providerStatus === "READY" && deploymentStatus === "BUILDING") return { action: "advance-deploying" };
  if ((providerStatus === "ERROR" || providerStatus === "CANCELED") && deploymentStatus === "BUILDING") return { action: "fail-build" };
  return { action: "pending" };
}

export function publicAccessRecoveryAction(status) {
  if (status === "LIVE") return { action: "live-replay-noop" };
  if (isRecoveryTerminalStatus(status)) return { action: "terminal-noop" };
  if (status === "HEALTH_CHECKING") return { action: "verify-public-access" };
  return { action: "invalid-state" };
}
