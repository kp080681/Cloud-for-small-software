export const DeploymentStatus = Object.freeze({
  DRAFT: "DRAFT",
  READY: "READY",
  QUEUED: "QUEUED",
  ANALYZING: "ANALYZING",
  PROVISIONING: "PROVISIONING",
  BUILDING: "BUILDING",
  DEPLOYING: "DEPLOYING",
  HEALTH_CHECKING: "HEALTH_CHECKING",
  LIVE: "LIVE",
  FAILED: "FAILED",
  DELETING: "DELETING",
  DELETED: "DELETED",
});

const transitions = Object.freeze({
  DRAFT: new Set(["READY", "DELETING"]),
  READY: new Set(["QUEUED", "DELETING"]),
  QUEUED: new Set(["ANALYZING", "FAILED", "DELETING"]),
  ANALYZING: new Set(["PROVISIONING", "BUILDING", "FAILED", "DELETING"]),
  PROVISIONING: new Set(["BUILDING", "FAILED", "DELETING"]),
  BUILDING: new Set(["DEPLOYING", "FAILED", "DELETING"]),
  DEPLOYING: new Set(["HEALTH_CHECKING", "FAILED", "DELETING"]),
  HEALTH_CHECKING: new Set(["LIVE", "FAILED", "DELETING"]),
  LIVE: new Set(["DELETING"]),
  FAILED: new Set(["QUEUED", "DELETING"]),
  DELETING: new Set(["DELETED", "FAILED"]),
  DELETED: new Set(),
});

export function canTransition(from, to) {
  if (!(from in transitions)) throw new Error(`Unknown deployment status: ${from}`);
  if (!(to in transitions)) throw new Error(`Unknown deployment status: ${to}`);
  return transitions[from].has(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal deployment transition: ${from} -> ${to}`);
  }
  return true;
}

export function isTerminal(status) {
  if (!(status in transitions)) throw new Error(`Unknown deployment status: ${status}`);
  return status === DeploymentStatus.LIVE || status === DeploymentStatus.DELETED;
}

export function nextStatusForSuccessfulStep(status, { databaseRequired = false } = {}) {
  switch (status) {
    case DeploymentStatus.QUEUED:
      return DeploymentStatus.ANALYZING;
    case DeploymentStatus.ANALYZING:
      return databaseRequired ? DeploymentStatus.PROVISIONING : DeploymentStatus.BUILDING;
    case DeploymentStatus.PROVISIONING:
      return DeploymentStatus.BUILDING;
    case DeploymentStatus.BUILDING:
      return DeploymentStatus.DEPLOYING;
    case DeploymentStatus.DEPLOYING:
      return DeploymentStatus.HEALTH_CHECKING;
    case DeploymentStatus.HEALTH_CHECKING:
      return DeploymentStatus.LIVE;
    default:
      throw new Error(`No automatic successful-step transition from ${status}`);
  }
}
