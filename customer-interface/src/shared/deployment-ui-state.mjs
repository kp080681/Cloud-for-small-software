export function retrySuccessMessage(deployment) {
  if (deployment?.retry?.limitReached) {
    return "Retry limit reached. Review the deployment details before trying a new deployment.";
  }
  if (deployment?.status === "LIVE") return "Existing deployment is live.";
  if (deployment?.retry?.created) return "Deployment retry started.";
  if (deployment?.retry?.alreadyStarted || deployment?.retry?.started === false) {
    return "Existing deployment resumed.";
  }
  return "Deployment retry started.";
}

export function redeploySuccessMessage(deployment) {
  if (deployment?.redeploy?.created) return "Redeployment started.";
  if (deployment?.redeploy?.reusedActive || deployment?.redeploy?.alreadyStarted) {
    return "Existing deployment resumed.";
  }
  return "Redeployment started.";
}

export function redeployFailureMessage() {
  return "Redeployment could not be started. Please try again.";
}
