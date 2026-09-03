export const SOURCE_LIMITS = Object.freeze({
  maxRepositoryEntries: 5000,
  maxDetectableSourceFiles: 500,
  maxTotalSourceBytes: 5 * 1024 * 1024,
  maxSingleSourceFileBytes: 512 * 1024,
  maxRepositoryPathLength: 240,
});

export class SourceBoundaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceBoundaryError";
    this.code = code;
  }
}

function unsafe(code, message) {
  return new SourceBoundaryError(code, message);
}

function decodePathInput(value) {
  let decoded = String(value ?? "");
  for (let i = 0; i < 3; i += 1) {
    if (!decoded.includes("%")) return decoded;
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw unsafe("SOURCE_PATH_UNSAFE", "Repository path contains malformed percent encoding");
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

export function normalizeRepositoryRelativePath(value, { allowRoot = false, errorCode = "SOURCE_PATH_UNSAFE" } = {}) {
  const raw = String(value ?? "");
  if (raw.includes("\0") || /%00/i.test(raw)) throw unsafe(errorCode, "Repository path contains a NUL byte");
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("//")) {
    throw unsafe(errorCode, "Repository path must be relative");
  }

  let normalized = decodePathInput(raw).replaceAll("\\", "/").trim();
  if (normalized.includes("\0") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/") || normalized.startsWith("//")) {
    throw unsafe(errorCode, "Repository path must stay inside the repository");
  }
  normalized = normalized.replace(/^\.\/+/, "").replace(/\/+$/, "");

  if (normalized === "" || normalized === ".") {
    if (allowRoot) return ".";
    throw unsafe(errorCode, "Repository file path cannot be empty");
  }
  if (normalized.length > SOURCE_LIMITS.maxRepositoryPathLength) {
    throw unsafe("SOURCE_PATH_TOO_LONG", "Repository path exceeds the V1 path length limit");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw unsafe(errorCode, "Repository path contains traversal or ambiguous segments");
  }
  return segments.join("/");
}

export function normalizeRootDirectory(value) {
  return normalizeRepositoryRelativePath(value || ".", { allowRoot: true, errorCode: "ROOT_DIRECTORY_INVALID" });
}

export function vercelRootDirectory(value) {
  const root = normalizeRootDirectory(value);
  return root === "." ? undefined : root;
}

export function relativePathUnderRoot(path, rootDirectory) {
  const normalizedPath = normalizeRepositoryRelativePath(path);
  const root = normalizeRootDirectory(rootDirectory);
  if (root === ".") return normalizedPath;
  if (normalizedPath === root) return "";
  return normalizedPath.startsWith(`${root}/`) ? normalizedPath.slice(root.length + 1) : null;
}

export function assertUniqueRepositoryPaths(paths) {
  if (paths.length > SOURCE_LIMITS.maxRepositoryEntries) {
    throw unsafe("SOURCE_FILE_LIMIT_EXCEEDED", "Repository tree exceeds the V1 file count limit");
  }

  const seen = new Set();
  return paths.map((path) => {
    const normalized = normalizeRepositoryRelativePath(path);
    if (seen.has(normalized)) {
      throw unsafe("SOURCE_PATH_UNSAFE", "Repository tree contains duplicate normalized paths");
    }
    seen.add(normalized);
    return normalized;
  });
}

export function assertDetectableSourceFileCount(count) {
  if (count > SOURCE_LIMITS.maxDetectableSourceFiles) {
    throw unsafe("SOURCE_FILE_LIMIT_EXCEEDED", "Source analysis exceeds the V1 detectable source file limit");
  }
}

export function assertSingleSourceFileSize(byteLength) {
  if (byteLength > SOURCE_LIMITS.maxSingleSourceFileBytes) {
    throw unsafe("SOURCE_FILE_TOO_LARGE", "Source file exceeds the V1 per-file byte limit");
  }
}

export function assertTotalSourceBytes(byteLength) {
  if (byteLength > SOURCE_LIMITS.maxTotalSourceBytes) {
    throw unsafe("SOURCE_TOO_LARGE", "Source analysis exceeds the V1 total byte limit");
  }
}

export function assertTextSource(content) {
  if (String(content).includes("\0")) {
    throw unsafe("SOURCE_UNSUPPORTED_CONTENT", "Source file appears to be binary content");
  }
}
