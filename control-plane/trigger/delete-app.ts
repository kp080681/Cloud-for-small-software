import { task } from "@trigger.dev/sdk";
import pg from "pg";

const { Client } = pg;
const API = "https://api.vercel.com";

function teamQuery() {
  const teamId = process.env.VERCEL_TEAM_ID;
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
}

async function deleteVercelProject(projectId: string) {
  if (!process.env.VERCEL_TOKEN) throw new Error("Missing VERCEL_TOKEN");
  const response = await fetch(`${API}/v9/projects/${encodeURIComponent(projectId)}${teamQuery()}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
  });
  if (response.status === 204 || response.status === 404 || response.status === 410) return;
  const text = await response.text();
  throw new Error(`Vercel project deletion failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ""}`);
}

export const deleteApp = task({
  id: "ssc-control-plane-delete-app",
  retry: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 8000, factor: 2, randomize: false },
  run: async (payload: { appId: string; workspaceId: string; deletionKey: string }) => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const appResult = await db.query(
        `SELECT a.id, a.workspace_id, a.deleted_at,
                rt.provider, rt.provider_project_id
           FROM apps a
           LEFT JOIN app_runtimes rt ON rt.app_id=a.id
          WHERE a.id=$1 AND a.workspace_id=$2`,
        [payload.appId, payload.workspaceId],
      );
      if (appResult.rowCount === 0) throw new Error("App not found in requested workspace");
      const app = appResult.rows[0];

      const existing = await db.query(`SELECT * FROM app_deletions WHERE app_id=$1`, [payload.appId]);
      if (existing.rowCount === 1) {
        const deletion = existing.rows[0];
        if (deletion.deletion_key !== payload.deletionKey) throw new Error("Deletion key does not match existing deletion request");
        if (deletion.status === "COMPLETED") {
          return { result: "NODE_04_13_REPLAY_NOOP", appId: payload.appId, deletionKey: payload.deletionKey, status: "COMPLETED" };
        }
      } else {
        await db.query(
          `INSERT INTO app_deletions
             (workspace_id,app_id,deletion_key,status,provider,provider_project_id)
           VALUES ($1,$2,$3,'REQUESTED',$4,$5)`,
          [payload.workspaceId, payload.appId, payload.deletionKey, app.provider, app.provider_project_id],
        );
      }

      const deletionResult = await db.query(`SELECT * FROM app_deletions WHERE app_id=$1`, [payload.appId]);
      const deletion = deletionResult.rows[0];
      if (deletion.workspace_id !== payload.workspaceId) throw new Error("Deletion workspace binding mismatch");
      if (deletion.provider_project_id !== app.provider_project_id) throw new Error("Provider project identity changed after deletion request");

      await db.query(`UPDATE app_deletions SET status='DELETING', error_code=NULL, error_message=NULL, updated_at=now() WHERE app_id=$1`, [payload.appId]);
      await db.query(`UPDATE deployments SET status='DELETING', updated_at=now() WHERE app_id=$1 AND status <> 'DELETED'`, [payload.appId]);

      if (deletion.provider_project_id) {
        if (deletion.provider !== "vercel") throw new Error(`Unsupported deletion provider: ${deletion.provider}`);
        await deleteVercelProject(deletion.provider_project_id);
      }

      await db.query(`UPDATE app_deletions SET status='PROVIDER_DELETED', provider_deleted_at=COALESCE(provider_deleted_at,now()), updated_at=now() WHERE app_id=$1`, [payload.appId]);

      await db.query("BEGIN");
      try {
        await db.query(`DELETE FROM runtime_secret_bindings WHERE app_id=$1`, [payload.appId]);
        await db.query(`DELETE FROM app_runtimes WHERE app_id=$1`, [payload.appId]);
        await db.query(`DELETE FROM encrypted_secrets WHERE app_id=$1`, [payload.appId]);
        await db.query(`UPDATE deployments SET status='DELETED', live_url=NULL, finished_at=COALESCE(finished_at,now()), updated_at=now() WHERE app_id=$1`, [payload.appId]);
        await db.query(`UPDATE apps SET deleted_at=COALESCE(deleted_at,now()), updated_at=now() WHERE id=$1`, [payload.appId]);
        await db.query(`UPDATE app_deletions SET status='COMPLETED', completed_at=COALESCE(completed_at,now()), updated_at=now() WHERE app_id=$1`, [payload.appId]);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }

      return {
        result: "NODE_04_13_APP_DELETED",
        appId: payload.appId,
        workspaceId: payload.workspaceId,
        deletionKey: payload.deletionKey,
        provider: deletion.provider,
        providerProjectId: deletion.provider_project_id,
        providerDeleted: Boolean(deletion.provider_project_id),
        secretsDeleted: true,
        runtimeBindingDeleted: true,
        status: "COMPLETED",
      };
    } catch (error: any) {
      try {
        await db.query(`UPDATE app_deletions SET status='FAILED', error_code='APP_DELETION_FAILED', error_message=$1, updated_at=now() WHERE app_id=$2 AND deletion_key=$3`, [String(error?.message ?? "App deletion failed").slice(0, 1000), payload.appId, payload.deletionKey]);
      } catch {}
      throw error;
    } finally {
      await db.end();
    }
  },
});
