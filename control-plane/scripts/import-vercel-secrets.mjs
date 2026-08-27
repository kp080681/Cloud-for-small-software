import pg from "pg";
import { encryptAppSecret } from "../src/secret-store.mjs";

const API = "https://api.vercel.com";
const APPROVED_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "ANTHROPIC_API_KEY",
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "CRON_SECRET",
  "RESEND_API_KEY",
  "NOTIFICATIONS_FROM_EMAIL",
];

for (const name of ["DATABASE_URL", "VERCEL_TOKEN", "SOURCE_VERCEL_PROJECT_ID", "AWS_REGION", "AWS_KMS_KEY_ID"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const appSlug = process.env.CONTROL_PLANE_APP_SLUG || "vantage";
const teamId = process.env.VERCEL_TEAM_ID;
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function vercelRequest(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
  });
  const text = await response.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (!response.ok) throw new Error(`Vercel API ${response.status} ${response.statusText}`);
  return body;
}

try {
  const appResult = await db.query(
    `SELECT id, workspace_id, name, slug FROM apps WHERE lower(slug) = lower($1) LIMIT 1`,
    [appSlug],
  );
  if (appResult.rowCount === 0) throw new Error(`App not found: ${appSlug}`);
  const app = appResult.rows[0];

  const listQuery = new URLSearchParams({ decrypt: "false" });
  if (teamId) listQuery.set("teamId", teamId);
  const list = await vercelRequest(`/v10/projects/${encodeURIComponent(process.env.SOURCE_VERCEL_PROJECT_ID)}/env?${listQuery.toString()}`);
  const envs = Array.isArray(list?.envs) ? list.envs : [];
  const productionByKey = new Map(
    envs
      .filter((item) => Array.isArray(item.target) && item.target.includes("production"))
      .map((item) => [item.key, item]),
  );

  const missing = APPROVED_KEYS.filter((key) => !productionByKey.has(key));
  if (missing.length) throw new Error(`Approved production variables missing from source project: ${missing.join(", ")}`);

  const imported = [];
  for (const key of APPROVED_KEYS) {
    const meta = productionByKey.get(key);
    const valueQuery = new URLSearchParams();
    if (teamId) valueQuery.set("teamId", teamId);
    const suffix = valueQuery.toString() ? `?${valueQuery.toString()}` : "";
    const full = await vercelRequest(`/v1/projects/${encodeURIComponent(process.env.SOURCE_VERCEL_PROJECT_ID)}/env/${encodeURIComponent(meta.id)}${suffix}`);
    const plaintext = full?.value;
    if (typeof plaintext !== "string" || plaintext.length === 0) throw new Error(`Decrypted value unavailable for ${key}`);

    const encrypted = await encryptAppSecret(db, {
      workspaceId: app.workspace_id,
      appId: app.id,
      name: key,
      plaintext,
    });

    await db.query(
      `INSERT INTO app_secret_bindings
         (workspace_id, app_id, env_key, secret_id, target_environment)
       VALUES ($1,$2,$3,$4,'production')
       ON CONFLICT (app_id, env_key, target_environment) DO UPDATE SET
         secret_id = EXCLUDED.secret_id,
         updated_at = now()`,
      [app.workspace_id, app.id, key, encrypted.id],
    );

    imported.push({ key, secretId: encrypted.id, sourceEnvId: meta.id, boundTo: "production" });
  }

  console.log(JSON.stringify({
    result: "NODE_04_9_SOURCE_SECRETS_IMPORTED",
    appSlug: app.slug,
    sourceProjectId: process.env.SOURCE_VERCEL_PROJECT_ID,
    importedCount: imported.length,
    imported,
    excludedKeys: ["DEALOS_API_BASE_URL", "VANTAGE_API_KEY", "SSC_TEST_SECRET"],
    plaintextPrinted: false,
    plaintextPersisted: false,
  }, null, 2));
} finally {
  await db.end();
}
