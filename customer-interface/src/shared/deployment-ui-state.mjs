// Central place for turning backend status codes and states into
// plain-language text for customers who are not developers — the platform's
// job is to translate "PROVISIONING" or "GITHUB_REPOSITORIES_UNAVAILABLE"
// into something a person can act on without knowing what those words mean.

const FRIENDLY_ERROR_MESSAGES = {
  WORKSPACE_RATE_LIMIT_REACHED: "You're doing that a bit too fast — please wait a few minutes and try again.",
  APP_PAUSED: "This app was paused after several failed deployments in a row. Check what went wrong, then ask for it to be resumed before trying again.",
  GITHUB_REPOSITORIES_UNAVAILABLE: "Utplava couldn't load your GitHub repositories. Try refreshing the page.",
  REPOSITORY_NOT_AVAILABLE: "That repository isn't available to select right now.",
  CONFIGURATION_STATUS_UNAVAILABLE: "Utplava couldn't check this app's configuration. Try refreshing the page.",
  SECRET_CONFIGURATION_FAILED: "That value couldn't be saved. Please try again.",
  SECRET_VALUE_REQUIRED: "Enter a value before saving.",
  DEPLOYMENT_STATUS_UNAVAILABLE: "Utplava couldn't check on this deployment. Try refreshing the page.",
  DEPLOYMENT_START_FAILED: "The deployment couldn't be started. Please try again.",
  DEPLOYMENT_RETRY_FAILED: "The retry couldn't be started. Please try again.",
  LIVE_DEPLOYMENT_REQUIRED: "This app needs to be live at least once before it can be redeployed.",
};

// Maps a backend error code to a plain-language sentence. Falls back to a
// generic, still-friendly message for any code without a specific mapping,
// so an unrecognized or future code never shows raw machine text.
export function friendlyErrorMessage(code, fallback = "Something went wrong. Please try again.") {
  if (typeof code === "string" && FRIENDLY_ERROR_MESSAGES[code]) {
    return FRIENDLY_ERROR_MESSAGES[code];
  }
  return fallback;
}

// Plain-language label for a deployment's current status, for the person
// watching it happen. Technical stage names ("PROVISIONING", "BUILDING")
// stay in events/diagnostics for anyone who wants detail, but the headline
// label a customer sees should never be a word from your own architecture.
export function stageLabelForStatus(status) {
  const labels = {
    ANALYZING: "Looking at your code",
    PROVISIONING: "Setting things up",
    BUILDING: "Building your app",
    DEPLOYING: "Getting your app ready",
    HEALTH_CHECKING: "Making sure it works",
    LIVE: "Live",
    FAILED: "Something went wrong",
    DELETING: "Deleting",
    DELETED: "Deleted",
  };
  return labels[status] || "Not started yet";
}

export function retrySuccessMessage(deployment) {
  if (deployment?.retry?.limitReached) {
    return "This deployment has been retried enough times without success. Review what went wrong before trying again.";
  }
  if (deployment?.status === "LIVE") return "This deployment is already live.";
  if (deployment?.retry?.created) return "Trying again — this'll take a moment.";
  if (deployment?.retry?.alreadyStarted || deployment?.retry?.started === false) {
    return "Already working on it — picking up where it left off.";
  }
  return "Trying again — this'll take a moment.";
}

export function redeploySuccessMessage(deployment) {
  if (deployment?.redeploy?.created) return "Redeploying — this'll take a moment.";
  if (deployment?.redeploy?.reusedActive || deployment?.redeploy?.alreadyStarted) {
    return "Already redeploying — picking up where it left off.";
  }
  return "Redeploying — this'll take a moment.";
}

export function redeployFailureMessage(code) {
  return friendlyErrorMessage(code, "Redeployment could not be started. Please try again.");
}
