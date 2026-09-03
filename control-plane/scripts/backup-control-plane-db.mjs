import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";

const { Client } = pg;

const BACKUP_DIR = process.env.CONTROL_PLANE_BACKUP_DIR || path.resolve(process.cwd(), ".ssc-backups");

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

function backupName() {
  return `ssc-control-plane-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.dump`;
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function readSafeMetadata(connectionString) {
  const db = new Client({ connectionString });
  await db.connect();
  try {
    const version = await db.query("SELECT version() AS version");
    const tables = await db.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    return {
      postgresVersion: version.rows[0].version,
      tableCount: tables.rowCount,
      tables: tables.rows.map((row) => row.table_name),
    };
  } finally {
    await db.end();
  }
}

const databaseUrl = requireEnv("DATABASE_URL");
assertToolAvailable("pg_dump");
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const outputPath = path.join(BACKUP_DIR, backupName());
const started = Date.now();
const dump = spawnSync(
  "pg_dump",
  ["--format=custom", "--no-owner", "--no-acl", "--file", outputPath],
  {
    encoding: "utf8",
    env: { ...process.env, ...libpqEnvFromUrl(databaseUrl) },
  },
);

if (dump.status !== 0) {
  throw new Error(`pg_dump failed with exit code ${dump.status}: ${dump.stderr || "no stderr"}`);
}

const stats = fs.statSync(outputPath);
const metadata = await readSafeMetadata(databaseUrl);

console.log(JSON.stringify({
  result: "CONTROL_PLANE_BACKUP_CREATED",
  backupPath: outputPath,
  backupBytes: stats.size,
  backupSha256: sha256File(outputPath),
  tableCount: metadata.tableCount,
  tables: metadata.tables,
  observedBackupDurationMs: Date.now() - started,
  plaintextSecretsPrinted: false,
}, null, 2));
