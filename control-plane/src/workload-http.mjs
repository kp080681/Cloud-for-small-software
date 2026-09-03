const FORBIDDEN_WORKLOAD_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-github-token",
  "x-trigger-secret",
  "x-vercel-token",
]);

function normalizeHeaders(headers = {}) {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function platformCredentialValues(env = process.env) {
  return [
    env.VERCEL_TOKEN,
    env.GITHUB_APP_PRIVATE_KEY,
    env.TRIGGER_SECRET_KEY,
    env.DATABASE_URL,
    env.AWS_SECRET_ACCESS_KEY,
    env.AWS_SESSION_TOKEN,
  ].filter((value) => typeof value === "string" && value.length > 0);
}

export function assertNoPlatformCredentialHeaders(headers, env = process.env) {
  const normalized = normalizeHeaders(headers);
  const credentialValues = platformCredentialValues(env);

  for (const [name, value] of Object.entries(normalized)) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_WORKLOAD_HEADERS.has(lower)) {
      throw new Error(`Workload request header is not allowed: ${name}`);
    }

    const text = Array.isArray(value) ? value.join(",") : String(value ?? "");
    if (credentialValues.some((credential) => text.includes(credential))) {
      throw new Error(`Workload request header contains a platform credential: ${name}`);
    }
  }

  return normalized;
}

export function safeWorkloadRequestHeaders(headers = {}, env = process.env) {
  return assertNoPlatformCredentialHeaders(headers, env);
}

export function healthCheckRequestInit({ signal } = {}) {
  return {
    method: "GET",
    redirect: "follow",
    signal,
    headers: safeWorkloadRequestHeaders({
      "User-Agent": "Small-Software-Cloud-Health-Check/1.0",
    }),
  };
}

export function publicAccessRequestInit({ signal, userAgent } = {}) {
  return {
    method: "GET",
    redirect: "manual",
    signal,
    headers: safeWorkloadRequestHeaders({
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }),
  };
}
