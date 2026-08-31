export const ENV_DETECTOR_VERSION = "node-04-17-static-process-env-v1";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SOURCE_BYTES = 512 * 1024;
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
  return String(path || "").replaceAll("\\", "/").replace(/^\/+/, "");
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

export function detectEnvReferencesInSource({ path, content }) {
  if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_BYTES) {
    return { detections: [], skipped: true, reason: "SOURCE_FILE_TOO_LARGE" };
  }

  const found = new Map();
  const dotPattern = /\bprocess\s*\.\s*env\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\b/g;
  const bracketPattern = /\bprocess\s*\.\s*env\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g;

  for (const pattern of [dotPattern, bracketPattern]) {
    for (const match of content.matchAll(pattern)) {
      const envKey = match[1];
      addReference(found, envKey, {
        path: normalizePath(path),
        line: lineNumberAt(content, match.index || 0),
        expression: match[0].replace(/\s+/g, " "),
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
