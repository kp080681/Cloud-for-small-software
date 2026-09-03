import fs from "node:fs";
import { spawnSync } from "node:child_process";

const REQUIRED_CONFIRMATION = "SSC_DISPOSABLE_RESTORE_TARGET";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function libpqEnvFromUrl(connectionString) {
  const url = new URL(connectionString);
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: url.pathname.replace(/^\//, ""),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get("sslmode") || "require",
  };
}

function assertToolAvailable(tool) {
  const command = process.platform === "win32" ? "where.exe" : "command";
  const args = process.platform === "win32" ? [tool] : ["-v", tool];
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${tool} was not found on PATH`);
}

const restoreDatabaseUrl = requireEnv("RESTORE_DATABASE_URL");
const backupFile = requireEnv("CONTROL_PLANE_BACKUP_FILE");
const confirmation = requireEnv("CONFIRM_DISPOSABLE_RESTORE");

if (confirmation !== REQUIRED_CONFIRMATION) {
  throw new Error(`Refusing restore without CONFIRM_DISPOSABLE_RESTORE=${REQUIRED_CONFIRMATION}`);
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL === restoreDatabaseUrl) {
  throw new Error("Refusing restore because RESTORE_DATABASE_URL matches DATABASE_URL");
}
if (!fs.existsSync(backupFile)) {
  throw new Error(`Backup file not found: ${backupFile}`);
}

assertToolAvailable("pg_restore");

const started = Date.now();
const libpqEnv = libpqEnvFromUrl(restoreDatabaseUrl);
const restore = spawnSync(
  "pg_restore",
  ["--clean", "--if-exists", "--no-owner", "--no-acl", "--exit-on-error", "--dbname", libpqEnv.PGDATABASE, backupFile],
  {
    encoding: "utf8",
    env: { ...process.env, ...libpqEnv },
  },
);

if (restore.status !== 0) {
  throw new Error(`pg_restore failed with exit code ${restore.status}: ${restore.stderr || "no stderr"}`);
}

console.log(JSON.stringify({
  result: "DISPOSABLE_CONTROL_PLANE_RESTORE_COMPLETED",
  restoreTargetConfirmedDisposable: true,
  observedRestoreDurationMs: Date.now() - started,
  plaintextSecretsPrinted: false,
}, null, 2));
