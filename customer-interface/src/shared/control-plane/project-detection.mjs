const DATABASE_DEPENDENCIES = new Set([
  "pg",
  "postgres",
  "postgresql",
  "@prisma/client",
  "prisma",
  "drizzle-orm",
  "@supabase/supabase-js",
]);

// Plain HTML websites (2026-10-25): an index.html at the top of the
// repository and nothing to build. Common for apps a chat assistant writes
// ("make me a simple math game"); the first real attempts on Utplava were
// two of these and both were turned away. Served as-is, so install and
// build are harmless no-ops (both columns are required downstream).
export const PLAIN_HTML_INSTALL_COMMAND = 'echo "Plain HTML site: nothing to install"';
export const PLAIN_HTML_BUILD_COMMAND = 'echo "Plain HTML site: nothing to build"';
const PLAIN_HTML_INDEX_FILES = new Set(["index.html", "index.htm"]);

function hasPlainHtmlIndex(rootFiles) {
  return rootFiles.some((name) => PLAIN_HTML_INDEX_FILES.has(String(name).toLowerCase()));
}

function plainHtmlDetection(rootFiles) {
  return {
    supported: true,
    framework: "static",
    runtime: "static",
    databaseRequired: false,
    plainHtml: true,
    packageManager: null,
    buildCommand: null,
    startCommand: null,
    envExamplePresent: rootFiles.some((name) => [".env.example", ".env.sample"].includes(name)),
    reason: null,
  };
}

export function detectProject({ packageJson, rootFiles = [] }) {
  if (!packageJson || typeof packageJson !== "object") {
    if (hasPlainHtmlIndex(rootFiles)) return plainHtmlDetection(rootFiles);
    return {
      supported: false,
      framework: null,
      runtime: null,
      databaseRequired: false,
      reason: "PACKAGE_JSON_NOT_FOUND",
    };
  }

  const dependencies = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };

  const isNext = Boolean(dependencies.next);
  // A "start" script is what actually runs as an ongoing server process —
  // that's the real signal for "this needs a Node.js runtime". A "build"
  // script alone is NOT that signal: plenty of static sites have one too
  // (to compile or minify assets), with nothing left running afterward.
  // Found live: a real external repository ("math-game") had only a build
  // script — a one-line echo, no real build step even — and this
  // previously classified it as needing a server, which Vercel's own API
  // correctly rejected at deploy time ("No entrypoint found").
  const hasStartScript = Boolean(packageJson.scripts?.start);
  const hasBuildScript = Boolean(packageJson.scripts?.build);
  const databaseRequired = [...DATABASE_DEPENDENCIES].some((name) => Boolean(dependencies[name]));

  let framework = null;
  let runtime = null;
  let supported = false;

  if (isNext) {
    framework = "nextjs";
    runtime = "nodejs";
    supported = true;
  } else if (hasStartScript) {
    framework = "nodejs";
    runtime = "nodejs";
    supported = true;
  } else if (hasBuildScript) {
    // "static", not null: a downstream readiness check
    // (repository-analysis.mjs's safeAnalysis) requires framework AND
    // runtime to both be truthy for an app to be considered ready to
    // deploy — a static site is exactly as ready as a server app, just
    // without a server runtime, so this must stay truthy too.
    framework = "static";
    runtime = "static";
    supported = true;
  }

  // A package.json with no build or start script (only there for a
  // formatter, say) in front of an index.html is still a plain website.
  if (!supported && hasPlainHtmlIndex(rootFiles)) return plainHtmlDetection(rootFiles);

  const envExamplePresent = rootFiles.some((name) => [".env.example", ".env.sample"].includes(name));

  return {
    supported,
    framework,
    runtime,
    databaseRequired,
    packageManager: rootFiles.includes("pnpm-lock.yaml")
      ? "pnpm"
      : rootFiles.includes("yarn.lock")
        ? "yarn"
        : rootFiles.includes("package-lock.json")
          ? "npm"
          : null,
    buildCommand: packageJson.scripts?.build || null,
    startCommand: packageJson.scripts?.start || null,
    envExamplePresent,
    reason: supported ? null : "UNSUPPORTED_PROJECT",
  };
}
