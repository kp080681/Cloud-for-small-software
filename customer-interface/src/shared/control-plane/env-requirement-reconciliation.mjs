export function sourceDetectedRequirement(detection) {
  return {
    envKey: detection.envKey,
    source: "source-detection",
    required: false,
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
