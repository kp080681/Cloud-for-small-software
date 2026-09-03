import { isIP } from "node:net";

export const WORKLOAD_HTTP_LIMITS = Object.freeze({
  maxRedirects: 5,
});

export class WorkloadUrlSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkloadUrlSafetyError";
    this.code = code;
  }
}

const FORBIDDEN_WORKLOAD_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-github-token",
  "x-trigger-secret",
  "x-vercel-token",
]);

const VERCEL_WORKLOAD_HOST_SUFFIXES = ["vercel.app"];

function failUrl(code, message) {
  return new WorkloadUrlSafetyError(code, message);
}

function normalizedHostname(hostname) {
  return String(hostname || "").toLowerCase().replace(/\.$/, "");
}

function ipv4Number(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function inCidr(value, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function isBlockedIpv4(hostname) {
  const value = ipv4Number(hostname);
  if (value === null) return false;
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
  ].some(([base, bits]) => inCidr(value, ipv4Number(base), bits));
}

function isBlockedIpv6(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:") ||
    host.startsWith("::ffff:127.") ||
    host.startsWith("::ffff:10.") ||
    host.startsWith("::ffff:192.168.") ||
    host.startsWith("::ffff:169.254.")
  );
}

function hostnameMatchesAllowedSuffix(hostname, allowedHostnameSuffixes) {
  return allowedHostnameSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

export function assertSafeWorkloadUrl(url, { allowedHostnameSuffixes = VERCEL_WORKLOAD_HOST_SUFFIXES } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw failUrl("WORKLOAD_URL_UNSAFE", "Workload URL is not a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw failUrl("WORKLOAD_URL_UNSAFE", "Workload URL must use HTTPS");
  }

  const hostname = normalizedHostname(parsed.hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata.google.internal" ||
    hostname === "169.254.169.254"
  ) {
    throw failUrl("WORKLOAD_URL_UNSAFE", "Workload URL targets a local or metadata host");
  }

  if (isIP(hostname) === 4 && isBlockedIpv4(hostname)) {
    throw failUrl("WORKLOAD_URL_UNSAFE", "Workload URL targets a private IPv4 range");
  }
  if (isIP(hostname) === 6 && isBlockedIpv6(hostname)) {
    throw failUrl("WORKLOAD_URL_UNSAFE", "Workload URL targets a private IPv6 range");
  }
  if (!hostnameMatchesAllowedSuffix(hostname, allowedHostnameSuffixes)) {
    throw failUrl("WORKLOAD_URL_UNSAFE", "Workload URL host is outside the expected provider domain");
  }

  return parsed;
}

export function assertSafeWorkloadRedirect(location, baseUrl, options = {}) {
  let redirected;
  try {
    redirected = new URL(location, baseUrl);
  } catch {
    throw failUrl("WORKLOAD_REDIRECT_UNSAFE", "Workload redirect target is not a valid URL");
  }
  try {
    assertSafeWorkloadUrl(redirected.toString(), options);
  } catch (error) {
    if (error instanceof WorkloadUrlSafetyError) {
      throw failUrl("WORKLOAD_REDIRECT_UNSAFE", error.message);
    }
    throw error;
  }
  return redirected;
}

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
    redirect: "manual",
    signal,
    headers: safeWorkloadRequestHeaders({
      "User-Agent": "Small-Software-Cloud-Health-Check/1.0",
    }),
  };
}

export async function fetchWorkloadUrl(url, init = {}, options = {}) {
  const maxRedirects = options.maxRedirects ?? WORKLOAD_HTTP_LIMITS.maxRedirects;
  let current = assertSafeWorkloadUrl(url, options);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetch(current.toString(), {
      ...init,
      redirect: "manual",
      headers: safeWorkloadRequestHeaders(init.headers ?? {}),
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current.toString(), redirectCount };
    }

    const location = response.headers.get("location");
    try {
      await response.body?.cancel();
    } catch {}
    if (!location) return { response, finalUrl: current.toString(), redirectCount };
    if (redirectCount >= maxRedirects) {
      throw failUrl("WORKLOAD_REDIRECT_UNSAFE", "Workload redirect limit exceeded");
    }
    current = assertSafeWorkloadRedirect(location, current.toString(), options);
  }

  throw failUrl("WORKLOAD_REDIRECT_UNSAFE", "Workload redirect limit exceeded");
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
