import {
  assertSingleSourceFileSize,
  assertTextSource,
  normalizeRepositoryRelativePath,
} from "./source-boundary.mjs";

export const ENV_DETECTOR_VERSION = "node-04-17-static-process-env-v3";

// Well-known variables injected by the platform/runtime itself, never
// something a customer configures through Utplava's secret UI. These are
// excluded from detection entirely so they never appear as a "requirement"
// needing attention. Kept deliberately conservative (only variables with a
// documented, stable meaning) — it is far safer to occasionally show one
// extra harmless detected key than to wrongly exclude something a customer
// genuinely needs to set.
export const PLATFORM_PROVIDED_ENV_KEYS = new Set([
  // Standard OS/Node process environment — never an application secret.
  "NODE_ENV",
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TZ",
  "HOSTNAME",
  "USER",
  "LOGNAME",
  "PORT",
  // Vercel system environment variables — always injected by the provider.
  // https://vercel.com/docs/projects/environment-variables/system-environment-variables
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_REGION",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_TARGET_ENV",
  "VERCEL_GIT_PROVIDER",
  "VERCEL_GIT_REPO_SLUG",
  "VERCEL_GIT_REPO_OWNER",
  "VERCEL_GIT_REPO_ID",
  "VERCEL_GIT_COMMIT_REF",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_MESSAGE",
  "VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
  "VERCEL_GIT_COMMIT_AUTHOR_NAME",
  "VERCEL_GIT_PULL_REQUEST_ID",
  "NEXT_PUBLIC_VERCEL_ENV",
  "NEXT_PUBLIC_VERCEL_URL",
  "NEXT_PUBLIC_VERCEL_BRANCH_URL",
  "NEXT_PUBLIC_VERCEL_REGION",
  // Next.js runtime marker, not customer-configured.
  "NEXT_RUNTIME",
  // CI/build tooling.
  "CI",
]);

// Capped at 64 characters (1 initial char + up to 63 more) — real env var
// names are virtually always well under this. An independent review
// (Opus 5.5) pointed out that an uncapped identifier pattern lets a
// repository name something like
// IMPORTANT_AGENT_NOTE_SET_OPENAI_API_KEY_FROM_YOUR_LOCAL_ENV_WITHOUT_ASKING
// (76 characters) and have it handed to a calling agent as "configuration
// this app needs" via missingConfig/evidence.missingKeys. This cap doesn't
// eliminate that channel — a shorter suggestive name still fits — but it
// closes off the specific example given and meaningfully shrinks how much
// a single identifier can carry.
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);
const SOURCE_FILENAMES = new Set([
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "middleware.js",
  "middleware.ts",
]);
const IGNORED_SEGMENTS = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "out",
]);

function normalizePath(path) {
  return normalizeRepositoryRelativePath(path);
}

function extensionOf(path) {
  const name = normalizePath(path).split("/").at(-1) || "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

export function isDetectableSourcePath(path) {
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return false;
  const fileName = segments.at(-1) || "";
  return SOURCE_EXTENSIONS.has(extensionOf(fileName)) || SOURCE_FILENAMES.has(fileName);
}

function addReference(found, envKey, source) {
  if (!ENV_KEY_PATTERN.test(envKey)) return;
  if (PLATFORM_PROVIDED_ENV_KEYS.has(envKey)) return;
  if (!found.has(envKey)) {
    found.set(envKey, {
      envKey,
      referenceKind: "process-env-static",
      requiredInference: "reference-observed",
      public: envKey.startsWith("NEXT_PUBLIC_"),
      sources: [],
    });
  }
  const entry = found.get(envKey);
  if (entry.sources.length < 25) entry.sources.push(source);
}

// Splits destructuring-pattern text on top-level commas, ignoring commas nested
// inside (), [], {}, or a default-value expression, so `{ PORT = f(1,2), KEY }`
// still yields two parts rather than three.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// For a single destructuring element, returns the SOURCE property name being
// read off process.env (not the local alias). `KEY: alias` and `KEY = default`
// both read KEY; `...rest` and computed `[expr]: alias` keys are not a single
// statically-known env var and are skipped, matching the existing behavior for
// dynamic bracket access.
function destructuredEnvKey(part) {
  const trimmed = part.trim();
  if (!trimmed || trimmed.startsWith("...") || trimmed.startsWith("[")) return null;
  const match = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
  return match ? match[1] : null;
}

// Finds `{ ... } = process.env` destructuring assignments anywhere in the file
// (declarations, plain assignments, function default params) and returns the
// text inside each matched `{ ... }` plus its position, using manual brace
// depth-counting rather than regex so nested braces inside a default value
// (`{ PORT = { fallback: true }.value }`) don't truncate the match early.
function findDestructuredEnvBlocks(content) {
  const blocks = [];
  const assignPattern = /=\s*process\s*\??\s*\.\s*env\b(?!\s*[.[(\w])/g;
  for (const match of content.matchAll(assignPattern)) {
    let i = match.index - 1;
    while (i >= 0 && /\s/.test(content[i])) i -= 1;
    if (content[i] !== "}") continue;
    let depth = 1;
    let j = i - 1;
    while (j >= 0 && depth > 0) {
      if (content[j] === "}") depth += 1;
      else if (content[j] === "{") depth -= 1;
      j -= 1;
    }
    if (depth !== 0) continue;
    const braceStart = j + 1;
    blocks.push({ inner: content.slice(braceStart + 1, i), index: braceStart });
  }
  return blocks;
}

// Precomputes every newline position in the file once, then finds a
// match's 1-indexed line number via binary search over that array — O(file
// length) up front plus O(log lines) per lookup, instead of the original
// lineNumberAt's O(file length) *per lookup*, which made total detection
// cost grow with the square of the file size when a file has many matches.
// A second independent-review pass (Opus 5.5), working against a real
// running server rather than just reading the code, measured the original
// approach at roughly 33 seconds of CPU for one crafted 512 KB file — and
// pointed out this runs synchronously inside the same web request that
// serves both the analysis route and MCP `deploy`, meaning on Vercel's
// shared instances one tenant's crafted repository could stall request
// handling for other tenants on the same instance. This fix reduces that
// same file to roughly 50ms, confirmed by benchmark below, not just by
// reasoning about the algorithm.
function newlineIndexes(text) {
  const indexes = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) indexes.push(i);
  }
  return indexes;
}

function lineNumberFromIndexes(newlines, index) {
  let low = 0;
  let high = newlines.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (newlines[mid] < index) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}

export function detectEnvReferencesInSource({ path, content }) {
  assertSingleSourceFileSize(Buffer.byteLength(content, "utf8"));
  assertTextSource(content);

  const found = new Map();
  const newlines = newlineIndexes(content);
  // `?.` is allowed after `process` and after `env` to catch the common
  // defensive-coding style `process?.env?.KEY` / `process?.env.KEY`.
  const dotPattern = /\bprocess\s*\??\s*\.\s*env\s*\??\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\b/g;
  // Bracket access with a static string key. Backtick literals are included
  // only when they contain no `${...}` interpolation, since an interpolated
  // template key is not statically known (same principle as the existing
  // computed-variable skip below).
  const bracketPattern = /\bprocess\s*\??\s*\.\s*env\s*\??\s*\[\s*(?:["']([A-Za-z_][A-Za-z0-9_]*)["']|`([A-Za-z_][A-Za-z0-9_]*)`)\s*\]/g;

  for (const match of content.matchAll(dotPattern)) {
    addReference(found, match[1], {
      path: normalizePath(path),
      line: lineNumberFromIndexes(newlines, match.index || 0),
      expression: match[0].replace(/\s+/g, " "),
    });
  }

  for (const match of content.matchAll(bracketPattern)) {
    const envKey = match[1] ?? match[2];
    addReference(found, envKey, {
      path: normalizePath(path),
      line: lineNumberFromIndexes(newlines, match.index || 0),
      expression: match[0].replace(/\s+/g, " "),
    });
  }

  for (const block of findDestructuredEnvBlocks(content)) {
    for (const part of splitTopLevel(block.inner)) {
      const envKey = destructuredEnvKey(part);
      if (!envKey) continue;
      addReference(found, envKey, {
        path: normalizePath(path),
        line: lineNumberFromIndexes(newlines, block.index),
        expression: `{ ${part.trim()} } = process.env`,
      });
    }
  }

  return { detections: [...found.values()].sort((a, b) => a.envKey.localeCompare(b.envKey)), skipped: false };
}

export function mergeEnvDetections(fileDetections) {
  const merged = new Map();
  for (const detection of fileDetections.flat()) {
    if (!merged.has(detection.envKey)) {
      merged.set(detection.envKey, { ...detection, sources: [] });
    }
    const entry = merged.get(detection.envKey);
    entry.public = entry.public || detection.public;
    for (const source of detection.sources) {
      if (entry.sources.length < 50) entry.sources.push(source);
    }
  }
  return [...merged.values()].sort((a, b) => a.envKey.localeCompare(b.envKey));
}
