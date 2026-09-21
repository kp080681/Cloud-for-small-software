// A source-detected reference defaults to required. Detection cannot prove a
// variable is mandatory (a reference could be behind a fallback or an unused
// code path), but leaving detected keys non-blocking by default meant nothing
// short of the platform-managed database ever actually stopped a deployment
// for missing customer configuration — the opposite of Node 04.17's purpose.
// Known platform-injected variables never reach this function at all (see
// PLATFORM_PROVIDED_ENV_KEYS in env-requirement-detection.mjs), which is what
// keeps this default from producing false blocks on things like NODE_ENV.
export function sourceDetectedRequirement(detection) {
  return {
    envKey: detection.envKey,
    source: "source-detection",
    required: true,
    public: Boolean(detection.public),
  };
}

export function reconcileExistingRequirement(existing, detection) {
  return {
    ...existing,
    required: Boolean(existing.required),
    public: Boolean(existing.public) || Boolean(detection.public),
  };
}

export function missingRequiredEnvKeys(requirements) {
  return requirements
    .filter((item) => item.required && !item.configured)
    .map((item) => item.envKey);
}
