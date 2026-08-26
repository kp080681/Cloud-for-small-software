const DATABASE_DEPENDENCIES = new Set([
  "pg",
  "postgres",
  "postgresql",
  "@prisma/client",
  "prisma",
  "drizzle-orm",
  "@supabase/supabase-js",
]);

export function detectProject({ packageJson, rootFiles = [] }) {
  if (!packageJson || typeof packageJson !== "object") {
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
  const isNode = Boolean(packageJson.scripts?.start || packageJson.scripts?.build);
  const databaseRequired = [...DATABASE_DEPENDENCIES].some((name) => Boolean(dependencies[name]));

  let framework = null;
  let runtime = null;
  let supported = false;

  if (isNext) {
    framework = "nextjs";
    runtime = "nodejs";
    supported = true;
  } else if (isNode) {
    framework = "nodejs";
    runtime = "nodejs";
    supported = true;
  }

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
