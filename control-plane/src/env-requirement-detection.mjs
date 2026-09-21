import {
  assertSingleSourceFileSize,
  assertTextSource,
  normalizeRepositoryRelativePath,
} from "./source-boundary.mjs";

export const ENV_DETECTOR_VERSION = "node-04-17-static-process-env-v2";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
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

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function addReference(found, envKey, source) {
  if (!ENV_KEY_PATTERN.test(envKey)) return;
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
  const assignPattern = /=\s*process\s*\.\s*env\b(?!\s*[.[(\w])/g;
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

export function detectEnvReferencesInSource({ path, content }) {
  assertSingleSourceFileSize(Buffer.byteLength(content, "utf8"));
  assertTextSource(content);

  const found = new Map();
  const dotPattern = /\bprocess\s*\.\s*env\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\b/g;
  // Bracket access with a static string key. Backtick literals are included
  // only when they contain no `${...}` interpolation, since an interpolated
  // template key is not statically known (same principle as the existing
  // computed-variable skip below).
  const bracketPattern = /\bprocess\s*\.\s*env\s*\[\s*(?:["']([A-Za-z_][A-Za-z0-9_]*)["']|`([A-Za-z_][A-Za-z0-9_]*)`)\s*\]/g;

  for (const match of content.matchAll(dotPattern)) {
    addReference(found, match[1], {
      path: normalizePath(path),
      line: lineNumberAt(content, match.index || 0),
      expression: match[0].replace(/\s+/g, " "),
    });
  }

  for (const match of content.matchAll(bracketPattern)) {
    const envKey = match[1] ?? match[2];
    addReference(found, envKey, {
      path: normalizePath(path),
      line: lineNumberAt(content, match.index || 0),
      expression: match[0].replace(/\s+/g, " "),
    });
  }

  for (const block of findDestructuredEnvBlocks(content)) {
    for (const part of splitTopLevel(block.inner)) {
      const envKey = destructuredEnvKey(part);
      if (!envKey) continue;
      addReference(found, envKey, {
        path: normalizePath(path),
        line: lineNumberAt(content, block.index),
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
