// App safety check (2026-10-26): a free, read-only scan of a public web app
// for the mistakes AI-built apps most often ship with. Explained in plain
// English, with the exact prompt to paste into Lovable or Cursor.
//
// Rules this module enforces, not just documents:
// - Read-only: only GET requests a normal browser would make. No logins,
//   forms, guessing or brute force. At most MAX_REQUESTS per scan.
// - Never inward: every connection is checked at connect time (not just
//   before), so DNS tricks can't reach private or cloud-metadata addresses.
// - Nothing kept: found secrets are masked before they leave this module,
//   and the module stores nothing.

import dns from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export const MAX_REQUESTS = 16;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_SCRIPT_BYTES = 2_500_000;
const MAX_PROBE_BYTES = 65_536;
const MAX_SCRIPTS = 8;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 8000;
const SCAN_DEADLINE_MS = 40_000;
const USER_AGENT = "UtplavaAppCheck/1.0 (+https://utplava.dev/check; read-only safety scan)";

export class CheckError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------- addresses

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4Range(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

// True for anything that isn't a normal public internet address.
export function isBlockedAddress(address) {
  if (!address) return true;
  let ip = String(address).toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // IPv4-mapped IPv6
  if (net.isIPv4(ip)) return BLOCKED_V4.some(([base, bits]) => inV4Range(ip, base, bits));
  if (net.isIPv6(ip)) {
    if (ip === "::" || ip === "::1") return true;
    const first = parseInt(ip.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (ip.startsWith("2001:db8")) return true; // documentation
    return false;
  }
  return true;
}

// DNS lookup used for every connection: refuses to connect anywhere private.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family || 4 }];
    const safe = list.filter((entry) => !isBlockedAddress(entry.address));
    if (!safe.length || safe.length !== list.length) {
      return callback(Object.assign(new Error("Refusing to connect to a private address"), { code: "BLOCKED_ADDRESS" }));
    }
    if (options?.all) return callback(null, safe);
    return callback(null, safe[0].address, safe[0].family);
  });
}

export function normalizeTarget(input) {
  let text = String(input || "").trim();
  if (!text) throw new CheckError("URL_REQUIRED", "Paste the address of your app, like myapp.com.");
  if (text.length > 500) throw new CheckError("URL_INVALID", "That address is too long.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new CheckError("URL_INVALID", "That doesn't look like a web address. Try something like myapp.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CheckError("URL_INVALID", "Only web addresses (http or https) can be checked.");
  if (url.username || url.password) throw new CheckError("URL_INVALID", "Remove any username or password from the address.");
  if (url.port && !["80", "443"].includes(url.port)) throw new CheckError("URL_NOT_ALLOWED", "Only standard web ports can be checked.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new CheckError("URL_NOT_ALLOWED", "Private and internal addresses can't be checked.");
  } else if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost" || host.endsWith(".localhost")) {
    throw new CheckError("URL_NOT_ALLOWED", "Private and internal addresses can't be checked.");
  }
  url.hash = "";
  return url;
}

// --------------------------------------------------------------- requesting

function requestOnce(url, { maxBytes }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let truncated = false;
        res.on("data", (chunk) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const done = () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), truncated, url: url.toString() });
        res.on("end", done);
        res.on("close", done);
        res.on("error", (error) => (truncated ? done() : reject(error)));
      },
    );
    const hardStop = setTimeout(() => req.destroy(Object.assign(new Error("Timed out"), { code: "TIMEOUT" })), REQUEST_TIMEOUT_MS);
    req.on("timeout", () => req.destroy(Object.assign(new Error("Timed out"), { code: "TIMEOUT" })));
    req.on("error", (error) => {
      clearTimeout(hardStop);
      reject(error);
    });
    req.on("close", () => clearTimeout(hardStop));
    req.end();
  });
}

// One scan's worth of requests, with the request budget and redirect
// re-validation (each hop is a new connection through guardedLookup).
function createRequester() {
  let used = 0;
  const startedAt = Date.now();
  return {
    get used() {
      return used;
    },
    async fetch(url, { maxBytes = MAX_PROBE_BYTES, followRedirects = true } = {}) {
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (used >= MAX_REQUESTS || Date.now() - startedAt > SCAN_DEADLINE_MS) throw Object.assign(new Error("Request budget used up"), { code: "BUDGET" });
        used += 1;
        const response = await requestOnce(current, { maxBytes });
        const location = response.headers.location;
        if (!followRedirects || ![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
        const next = new URL(location, current);
        if (next.protocol !== "https:" && next.protocol !== "http:") return response;
        normalizeTarget(next.toString()); // same rules for every hop
        current = next;
      }
      throw Object.assign(new Error("Too many redirects"), { code: "REDIRECTS" });
    },
  };
}

// ----------------------------------------------------------------- findings

export function maskSecret(value) {
  const text = String(value);
  return `${text.slice(0, Math.min(8, Math.max(4, Math.floor(text.length / 6))))}…`;
}

function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// Each pattern: what it is, how bad, what to tell the person and their AI.
const SECRET_PATTERNS = [
  {
    id: "openai-key",
    regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/g,
    exclude: /^sk-ant-/,
    severity: "critical",
    title: "OpenAI secret key is visible to anyone",
    explain: "Your OpenAI key is inside the code your site sends to every visitor. Anyone can copy it and use your credits.",
    fix: "Revoke this OpenAI key in the OpenAI dashboard, then: \"Move all OpenAI calls to a server-side function (for example a Supabase Edge Function). The browser must never contain the OpenAI key; read it from an environment variable on the server.\"",
  },
  {
    id: "anthropic-key",
    regex: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g,
    severity: "critical",
    title: "Anthropic (Claude) API key is visible to anyone",
    explain: "Your Anthropic key is inside your site's code. Anyone can copy it and run up charges on your account.",
    fix: "Revoke this key in the Anthropic Console, then: \"Move all Anthropic API calls to a server-side function and read the key from a server environment variable. Remove it from all frontend code.\"",
  },
  {
    id: "stripe-secret",
    regex: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g,
    severity: "critical",
    title: "Stripe live secret key is visible to anyone",
    explain: "This key can create charges, refunds and read customer data on your Stripe account. It must never be in a website's code.",
    fix: "Roll this key immediately in the Stripe dashboard, then: \"Move all Stripe secret-key calls to a server-side function. The frontend may only use the publishable key (pk_...).\"",
  },
  {
    id: "stripe-test-secret",
    regex: /\bsk_test_[0-9A-Za-z]{16,}\b/g,
    severity: "high",
    title: "Stripe test secret key is in your site's code",
    explain: "It's only a test key, but it shows secret keys are reaching the browser. When you switch to live payments, the live key would leak the same way.",
    fix: "\"Move all Stripe secret-key usage to a server-side function and keep only the publishable key (pk_...) in the frontend.\"",
  },
  {
    id: "supabase-secret",
    regex: /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g,
    severity: "critical",
    title: "Supabase secret key is visible to anyone",
    explain: "This key bypasses all your database rules. Anyone with it can read, change or delete every user's data.",
    fix: "Rotate it in Supabase (Project Settings → API keys), then: \"Remove the Supabase secret key from all frontend code. Only the publishable/anon key belongs in the browser; use the secret key only in server-side functions.\"",
  },
  {
    id: "aws-key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    severity: "high",
    title: "AWS access key ID is in your site's code",
    explain: "An AWS key ID is exposed. If its secret is anywhere nearby, someone could use your AWS account.",
    fix: "Deactivate this key in AWS IAM, then: \"Remove AWS credentials from all frontend code and call AWS only from a server-side function using environment variables.\"",
  },
  {
    id: "github-token",
    regex: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/g,
    severity: "critical",
    title: "GitHub token is visible to anyone",
    explain: "This token can access your GitHub repositories. Anyone who opens your site can copy it.",
    fix: "Revoke it at github.com → Settings → Developer settings → Tokens, then: \"Remove the GitHub token from the frontend and call GitHub only from a server-side function.\"",
  },
  {
    id: "private-key",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    severity: "critical",
    title: "A private key is in your site's code",
    explain: "A private key (the kind used to sign or decrypt) is being sent to every visitor. It should never leave a server.",
    fix: "Replace this key wherever it's used, then: \"Remove the private key from all frontend code and files. Load it only on the server from an environment variable.\"",
  },
  {
    id: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    severity: "medium",
    title: "Google API key found: check it's restricted",
    explain: "Some Google keys (like Maps) are meant to be public, but only if they're restricted to your website. An unrestricted key can be used by anyone, on your bill.",
    fix: "In Google Cloud Console → Credentials, restrict this key to your website's address and only the APIs it needs. If it's for a paid API like Gemini, move those calls to a server-side function.",
  },
];

const JWT_REGEX = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

export function scanTextForSecrets(text, source) {
  const findings = [];
  const seen = new Set();
  for (const pattern of SECRET_PATTERNS) {
    for (const match of String(text).matchAll(pattern.regex)) {
      const value = match[0];
      if (pattern.exclude && pattern.exclude.test(value)) continue;
      const key = `${pattern.id}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ id: pattern.id, severity: pattern.severity, title: pattern.title, explain: pattern.explain, fix: pattern.fix, evidence: `${maskSecret(value)} in ${source}` });
    }
  }
  let supabaseAnon = false;
  for (const match of String(text).matchAll(JWT_REGEX)) {
    const payload = decodeJwtPayload(match[0]);
    if (!payload) continue;
    if (payload.role === "service_role") {
      const key = `supabase-service-role:${match[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        id: "supabase-service-role",
        severity: "critical",
        title: "Supabase service_role key is visible to anyone",
        explain: "This key ignores all your Row Level Security rules. Anyone who opens your site can read, change or delete every user's data.",
        fix: "Rotate it in Supabase (Project Settings → API), then: \"Remove the Supabase service_role key from all frontend code. The browser must only use the anon/publishable key; use service_role only inside server-side Edge Functions.\"",
        evidence: `${maskSecret(match[0])} in ${source}`,
      });
    } else if (payload.role === "anon" && String(payload.iss || "").includes("supabase")) {
      supabaseAnon = true;
    }
  }
  return { findings, supabaseAnon };
}

function looksLikeHtml(body) {
  return /^\s*(<!doctype html|<html|<head|<body|<script|<meta)/i.test(body);
}

// A real .env file: several KEY=value lines, not an HTML fallback page.
export function looksLikeEnvFile(body) {
  if (!body || looksLikeHtml(body)) return false;
  const lines = body.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));
  if (!lines.length) return false;
  const kv = lines.filter((line) => /^\s*(?:export\s+)?[A-Z][A-Z0-9_]{1,80}\s*=/.test(line));
  return kv.length >= 1 && kv.length / lines.length >= 0.6;
}

export function looksLikeGitConfig(body) {
  return Boolean(body) && !looksLikeHtml(body) && /^\s*\[core\]/m.test(body);
}

const HEADER_CHECKS = [
  {
    id: "hsts",
    passedLabel: "Forces HTTPS in browsers (HSTS)",
    test: (h) => Boolean(h["strict-transport-security"]),
    title: "Browsers aren't told to always use HTTPS",
    explain: "Without this setting (HSTS), a visitor on public Wi-Fi can be tricked onto an insecure version of your site.",
    fix: "Add the response header Strict-Transport-Security: max-age=31536000; includeSubDomains. Most hosts (including Utplava's) can set it for you.",
  },
  {
    id: "csp",
    passedLabel: "Has a Content Security Policy",
    test: (h) => Boolean(h["content-security-policy"]),
    title: "No Content Security Policy",
    explain: "A Content Security Policy limits which scripts can run on your page, which blocks a whole class of attacks if something malicious gets injected.",
    fix: "\"Add a Content-Security-Policy header that only allows scripts from my own domain and the services I actually use.\" Start with report-only mode if you're unsure.",
  },
  {
    id: "framing",
    passedLabel: "Can't be embedded by other sites",
    test: (h) => Boolean(h["x-frame-options"]) || /frame-ancestors/i.test(String(h["content-security-policy"] || "")),
    title: "Your site can be embedded inside other sites",
    explain: "Another site could load yours in a hidden frame and trick people into clicking things (\"clickjacking\").",
    fix: "Add the header X-Frame-Options: DENY (or a Content-Security-Policy with frame-ancestors 'self').",
  },
  {
    id: "nosniff",
    passedLabel: "Stops browsers guessing file types",
    test: (h) => String(h["x-content-type-options"] || "").toLowerCase().includes("nosniff"),
    title: "Browsers may guess file types",
    explain: "Without X-Content-Type-Options: nosniff, a browser might treat an uploaded file as a script.",
    fix: "Add the header X-Content-Type-Options: nosniff.",
  },
  {
    id: "referrer",
    passedLabel: "Has a referrer policy",
    test: (h) => Boolean(h["referrer-policy"]),
    title: "No referrer policy",
    explain: "Without it, the full address of your pages (which can include private details) may be sent to other sites your visitors click to.",
    fix: "Add the header Referrer-Policy: strict-origin-when-cross-origin.",
  },
];

const SEVERITY_COST = { critical: 4, high: 2, medium: 1, low: 0.5, info: 0 };
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function scoreFindings(findings) {
  const cost = findings.reduce((sum, f) => sum + (SEVERITY_COST[f.severity] ?? 0), 0);
  return Math.max(0, Math.round(10 - cost));
}

function scriptSources(html, pageUrl) {
  const sources = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1], pageUrl);
      if (url.hostname === pageUrl.hostname && (url.protocol === "https:" || url.protocol === "http:")) sources.push(url);
    } catch {
      // ignore unparseable src
    }
  }
  const unique = [];
  const seen = new Set();
  for (const url of sources) {
    const key = url.toString();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(url);
    }
  }
  return unique.slice(0, MAX_SCRIPTS);
}

function inlineScripts(html) {
  return [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
}

// ---------------------------------------------------------------- the scan

// Supabase project addresses found in an app's own code. Only these exact
// <ref>.supabase.co hosts are ever contacted, one request each.
export function supabaseProjectHosts(texts) {
  const hosts = new Set();
  for (const text of texts) {
    for (const match of String(text).matchAll(/\b([a-z0-9]{20})\.supabase\.co\b/gi)) hosts.add(`${match[1].toLowerCase()}.supabase.co`);
  }
  return [...hosts].slice(0, 2);
}

// Is the backend behind this app still there? A paused or deleted Supabase
// project usually stops resolving in DNS (and a paused one can answer 540),
// while the app's own page keeps loading normally, so owners don't notice.
async function checkSupabaseBackend(host, { requester, lookupHost }) {
  try {
    await lookupHost(host);
  } catch (error) {
    if (["ENOTFOUND", "ENODATA", "EAI_NONAME"].includes(error?.code)) return "gone";
    return "unknown";
  }
  try {
    const response = await requester.fetch(new URL(`https://${host}/auth/v1/health`), { maxBytes: 4096, followRedirects: false });
    if (response.status === 540 || (response.status === 503 && /paus/i.test(response.body))) return "paused";
    return "ok";
  } catch {
    return "unknown";
  }
}

export async function runAppCheck(input, { requester = createRequester(), lookupHost = dnsLookup } = {}) {
  const target = normalizeTarget(input);
  const findings = [];
  const passed = [];
  let page;
  try {
    page = await requester.fetch(target, { maxBytes: MAX_PAGE_BYTES });
  } catch (error) {
    if (error?.code === "BLOCKED_ADDRESS") throw new CheckError("URL_NOT_ALLOWED", "Private and internal addresses can't be checked.");
    throw new CheckError("UNREACHABLE", "Couldn't reach that address. Check it's spelled right and the site is online.", 422);
  }
  if (page.status >= 400) {
    throw new CheckError("UNREACHABLE", `That address answered with an error (${page.status}). Check it opens in your browser.`, 422);
  }
  const finalUrl = new URL(page.url);
  const headers = page.headers || {};

  // HTTPS
  if (finalUrl.protocol !== "https:") {
    findings.push({
      id: "no-https",
      severity: "high",
      title: "Your site isn't using HTTPS",
      explain: "Everything your visitors type, including passwords, travels unencrypted and can be read on shared networks.",
      fix: "Turn on HTTPS for your domain. Hosts like Utplava do this automatically.",
    });
  } else {
    passed.push("Uses HTTPS");
    try {
      const plain = new URL(finalUrl.toString());
      plain.protocol = "http:";
      plain.port = "";
      const insecure = await requester.fetch(plain, { maxBytes: 4096, followRedirects: false });
      const location = String(insecure.headers?.location || "");
      if ([301, 302, 307, 308].includes(insecure.status) && location.startsWith("https://")) passed.push("Sends http:// visitors to https://");
      else if (insecure.status < 400) {
        findings.push({
          id: "http-not-redirected",
          severity: "medium",
          title: "The insecure http:// version still works",
          explain: "People who type your address without https:// land on an unencrypted page instead of being moved to the secure one.",
          fix: "Redirect all http:// requests to https:// in your hosting settings.",
        });
      }
    } catch {
      // http not reachable at all is fine
    }
  }

  // Leaked secrets in the page and its own scripts
  let supabaseSeen = /supabase\.co/i.test(page.body);
  const scanned = [{ name: "the page itself", text: `${page.body}\n${inlineScripts(page.body)}` }];
  for (const src of scriptSources(page.body, finalUrl)) {
    try {
      const script = await requester.fetch(src, { maxBytes: MAX_SCRIPT_BYTES });
      if (script.status < 400) scanned.push({ name: src.pathname.split("/").pop() || src.pathname, text: script.body });
    } catch (error) {
      if (error?.code === "BUDGET") break;
    }
  }
  let anySecret = false;
  for (const source of scanned) {
    const result = scanTextForSecrets(source.text, source.name);
    if (result.findings.length) anySecret = true;
    findings.push(...result.findings);
    if (result.supabaseAnon || /supabase\.co/i.test(source.text)) supabaseSeen = true;
  }
  const scriptCount = scanned.length - 1;
  if (!anySecret) passed.push(scriptCount ? `No secret keys found in the page or its ${scriptCount} script file${scriptCount === 1 ? "" : "s"}` : "No secret keys found in the page");

  // Files that should never be public
  const probes = [
    { path: "/.env", kind: "env" },
    { path: "/.env.local", kind: "env" },
    { path: "/.env.production", kind: "env" },
    { path: "/.git/config", kind: "git" },
  ];
  let exposed = false;
  for (const probe of probes) {
    try {
      const response = await requester.fetch(new URL(probe.path, finalUrl.origin), { maxBytes: MAX_PROBE_BYTES, followRedirects: false });
      if (response.status !== 200) continue;
      if (probe.kind === "env" && looksLikeEnvFile(response.body)) {
        exposed = true;
        const names = [...response.body.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,80})\s*=/gm)].map((m) => m[1]).slice(0, 5);
        findings.push({
          id: "env-exposed",
          severity: "critical",
          title: `Your ${probe.path} file can be downloaded by anyone`,
          explain: "This file usually holds every password and API key your app uses. Anyone can open it in a browser right now.",
          fix: "Delete it from your public files, then rotate every key that was in it. Then: \"Make sure .env files are never deployed or served publicly; add them to .gitignore and use the host's environment variable settings instead.\"",
          evidence: names.length ? `Contains settings named ${names.join(", ")}${names.length === 5 ? "…" : ""} (values not shown)` : undefined,
        });
      } else if (probe.kind === "git" && looksLikeGitConfig(response.body)) {
        exposed = true;
        findings.push({
          id: "git-exposed",
          severity: "critical",
          title: "Your .git folder is public",
          explain: "Anyone can download your full source code history from this folder, including any secrets that were ever committed.",
          fix: "Stop serving the .git folder (deploy from a build output, not the repository folder itself), and rotate any keys that were ever committed.",
        });
      }
    } catch (error) {
      if (error?.code === "BUDGET") break;
    }
  }
  if (!exposed) passed.push("No .env or .git files are publicly downloadable");

  // Security headers
  for (const check of HEADER_CHECKS) {
    if (check.id === "csp" && check.test(headers) && !/(?:^|[;,]\s*)(?:script-src|default-src)\b/i.test(String(headers["content-security-policy"]))) {
      findings.push({
        id: "header-csp-scripts",
        severity: "low",
        title: "Your Content Security Policy doesn't limit scripts yet",
        explain: "You have a policy (it may stop framing or plugins), but it doesn't say which scripts may run, so it won't block injected scripts.",
        fix: "\"Extend the Content-Security-Policy with a script-src that only allows my own domain and the services I actually use.\" Try it in report-only mode first so nothing breaks.",
      });
    } else if (check.test(headers)) passed.push(check.passedLabel);
    else findings.push({ id: `header-${check.id}`, severity: "low", title: check.title, explain: check.explain, fix: check.fix });
  }

  // Supabase backend still answering?
  let backendDown = false;
  for (const host of supabaseProjectHosts(scanned.map((source) => source.text))) {
    const state = await checkSupabaseBackend(host, { requester, lookupHost });
    if (state === "gone" || state === "paused") {
      backendDown = true;
      findings.push({
        id: "supabase-backend-down",
        severity: "high",
        title: "Your app's Supabase backend isn't answering",
        explain: state === "paused"
          ? "The Supabase project behind your app is paused. Your homepage still loads, but signing in, saving or loading data will fail for every visitor."
          : "The Supabase project your app points to can't be found: it's paused or deleted. Your homepage still loads, but signing in, saving or loading data will fail for every visitor.",
        fix: "Open supabase.com/dashboard. If the project is paused, click Restore (free projects pause after about a week without activity; a paid plan or regular use keeps it awake). If it's gone, create a new project and ask your AI tool: \"Point the app at my new Supabase project URL and anon key, and recreate the tables it needs.\"",
        evidence: `${host} (${state === "paused" ? "paused" : "not found"})`,
      });
    } else if (state === "ok") {
      passed.push("Your Supabase backend is answering");
    }
  }

  // Supabase: the most common real leak can't be tested from outside
  if (supabaseSeen && !backendDown) {
    findings.push({
      id: "supabase-rls",
      severity: "info",
      title: "Your app uses Supabase: check Row Level Security",
      explain: "This scan can't see your database rules from outside. The most common real leak in AI-built apps is a table with Row Level Security switched off.",
      fix: "In Supabase open Advisors → Security and fix anything listed. Then test with two accounts: logged in as A, try to see B's data. Prompt: \"Enable Row Level Security on every table with user data, with policies so users can only read and change their own rows.\"",
    });
  }

  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  return {
    target: finalUrl.origin,
    score: scoreFindings(findings),
    findings,
    passed,
    requestsMade: requester.used,
    checkedAt: new Date().toISOString(),
  };
}
