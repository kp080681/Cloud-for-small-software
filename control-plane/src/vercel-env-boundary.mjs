export const SSC_ALPHA_ENV_TARGETS = Object.freeze(["production"]);

export function isPublicEnvironmentKey(envKey) {
  return String(envKey ?? "").startsWith("NEXT_PUBLIC_");
}

export function vercelProjectEnvPayload({ envKey, plaintext }) {
  if (!envKey) throw new Error("Environment key is required");
  return {
    key: envKey,
    value: plaintext,
    type: "sensitive",
    target: [...SSC_ALPHA_ENV_TARGETS],
    comment: "Managed by Small Software Cloud",
  };
}

export function providerEnvId(response) {
  if (Array.isArray(response)) return response[0]?.id ?? response[0]?.created?.id ?? null;
  return response?.id ?? response?.created?.id ?? null;
}

export function assertVercelEnvUpsertSucceeded(response, envKey) {
  const failed = Array.isArray(response?.failed) ? response.failed : [];
  if (failed.length > 0) {
    const matching = failed.find((item) => item?.error?.envVarKey === envKey || item?.error?.key === envKey);
    const code = matching?.error?.code ?? failed[0]?.error?.code ?? "UNKNOWN";
    throw new Error(`Vercel environment upsert failed for ${envKey}: ${code}`);
  }
  return response;
}

export function providerEnvTargets(response) {
  const item = Array.isArray(response) ? response[0] : (response?.created ?? response);
  return Array.isArray(item?.target) ? item.target : null;
}
