// "Take your database with you" (2026-10-23). A managed app database is
// plain PostgreSQL on Neon; giving the owner its connection string is all
// they need to back it up or move it anywhere (pg_dump, any Postgres host).
// Only for databases Utplava created (SSC_MANAGED) and that are READY, and
// only to members of the app's workspace.

import { decryptAppSecret } from "../shared/control-plane/secret-store.mjs";

const MANAGED_READY_SQL = `
  SELECT ad.id, ad.status, ad.provider, ad.created_at
    FROM customer_workspace_memberships m
    JOIN apps a ON a.workspace_id = m.workspace_id
    JOIN app_databases ad ON ad.app_id = a.id
   WHERE m.customer_identity_id = $1
     AND m.workspace_id = $2
     AND a.id = $3
     AND a.deleted_at IS NULL
     AND ad.database_mode = 'SSC_MANAGED'
     AND ad.deleted_at IS NULL
   LIMIT 1`;

// Utplava's apps use Neon's pooled address (…-pooler.…). Backup and
// migration tools such as pg_dump need a direct session, so hand out the
// direct host: same database, same credentials, just without "-pooler".
export function directConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    url.hostname = url.hostname.replace(/-pooler(?=\.)/, "");
    return url.toString();
  } catch {
    return connectionString;
  }
}

export async function getAppDatabaseSummary(db, { customerId, workspaceId, appId }) {
  const result = await db.query(MANAGED_READY_SQL, [customerId, workspaceId, appId]);
  const row = result.rows[0];
  if (!row) return null;
  return { status: row.status, ready: row.status === "READY", createdAt: row.created_at ? new Date(row.created_at).toISOString() : null };
}

export async function revealAppDatabaseConnection(db, { customerId, workspaceId, appId, decrypt = decryptAppSecret }) {
  const summary = await getAppDatabaseSummary(db, { customerId, workspaceId, appId });
  if (!summary) throw Object.assign(new Error("This app has no Utplava database."), { status: 404, code: "APP_DATABASE_NOT_FOUND" });
  if (!summary.ready) throw Object.assign(new Error("The database isn't ready yet."), { status: 409, code: "APP_DATABASE_NOT_READY" });
  let connectionString;
  try {
    connectionString = await decrypt(db, { appId, name: "DATABASE_URL" });
  } catch {
    throw Object.assign(new Error("The connection details couldn't be read."), { status: 502, code: "APP_DATABASE_SECRET_UNAVAILABLE" });
  }
  if (!/^postgres(ql)?:\/\//.test(connectionString)) {
    throw Object.assign(new Error("The stored connection details look wrong."), { status: 502, code: "APP_DATABASE_SECRET_UNAVAILABLE" });
  }
  return { connectionString: directConnectionString(connectionString) };
}
