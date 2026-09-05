import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { requireAppSlug, requireWorkspaceId, resolveAppTarget } from "../src/operator-targeting.mjs";
import { encryptAppSecret } from "../src/secret-store.mjs";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");
if (!process.env.AWS_REGION) throw new Error("Missing required environment variable: AWS_REGION");
if (!process.env.AWS_KMS_KEY_ID) throw new Error("Missing required environment variable: AWS_KMS_KEY_ID");

const workspaceId = requireWorkspaceId();
const appSlug = requireAppSlug();
const inputPath = process.env.SSC_ENV_FILE;
if (!inputPath) throw new Error("Missing required environment variable: SSC_ENV_FILE");

function parseEnv(text) {
  const values = new Map();
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equals = normalized.indexOf("=");
    if (equals <= 0) continue;
    const key = normalized.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = normalized.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let raw = "";

try {
  const app = await resolveAppTarget(db, { workspaceId, slug: appSlug });
  raw = await fs.readFile(inputPath, "utf8");
  const supplied = parseEnv(raw);

  const requirementResult = await db.query(
    `SELECT env_key FROM app_env_requirements WHERE app_id=$1 AND required=true ORDER BY env_key`,
    [app.id],
  );
  const required = requirementResult.rows.map((row) => row.env_key);
  const accepted = required.filter((key) => supplied.has(key) && supplied.get(key) !== "");
  const missing = required.filter((key) => !supplied.has(key) || supplied.get(key) === "");
  const ignored = [...supplied.keys()].filter((key) => !required.includes(key)).sort();

  for (const key of accepted) {
    const encrypted = await encryptAppSecret(db, {
      workspaceId: app.workspace_id,
      appId: app.id,
      name: key,
      plaintext: supplied.get(key),
    });
    await db.query(
      `INSERT INTO app_secret_bindings
         (workspace_id, app_id, env_key, secret_id, target_environment)
       VALUES ($1,$2,$3,$4,'production')
       ON CONFLICT (app_id, env_key, target_environment) DO UPDATE SET
         secret_id=EXCLUDED.secret_id,
         updated_at=now()`,
      [app.workspace_id, app.id, key, encrypted.id],
    );
  }

  console.log(JSON.stringify({
    result: missing.length ? "NODE_04_9_ENV_PARTIALLY_IMPORTED" : "NODE_04_9_ENV_IMPORTED",
    appSlug: app.slug,
    sourceFileName: path.basename(inputPath),
    requiredCount: required.length,
    importedCount: accepted.length,
    importedKeys: accepted,
    missingCount: missing.length,
    missingKeys: missing,
    ignoredCount: ignored.length,
    ignoredKeys: ignored,
    rawFilePersisted: false,
    plaintextPrinted: false,
  }, null, 2));
} finally {
  raw.replace?.(/./g, "");
  await db.end();
}
