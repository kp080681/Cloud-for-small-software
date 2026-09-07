import { task } from "@trigger.dev/sdk";
import pg from "pg";
import {
  assertProviderProjectNotOwnedByAnotherApp,
  assertRemoteProjectMatchesSscApp,
} from "../src/provider-project-identity.mjs";
import { deleteManagedDatabaseForApp } from "../src/managed-database-lifecycle.mjs";
import { deleteNeonProject, getNeonProject, listNeonProjectsByName } from "../src/neon-managed-postgres.mjs";

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

async function getVercelProject(projectId: string) {
  if (!process.env.VERCEL_TOKEN) throw new Error("Missing VERCEL_TOKEN");
  const response = await fetch(`${API}/v9/projects/${encodeURIComponent(projectId)}${teamQuery()}`, {
    headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vercel project lookup failed before deletion: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ""}`);
  }
  return response.json();
}

export const deleteApp = task({
  id: "ssc-control-plane-delete-app",
  retry: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 8000, factor: 2, randomize: false },
  run: async (payload: { appId: string; workspaceId: string; deletionKey: string }) => {
    if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      await db.query("BEGIN");
      let app;
      const appResult = await db.query(
        `SELECT a.id, a.workspace_id, a.slug, a.deleted_at,
                rt.provider, rt.provider_project_id, rt.provider_project_name
           FROM apps a
           LEFT JOIN app_runtimes rt ON rt.app_id=a.id
          WHERE a.id=$1 AND a.workspace_id=$2
          FOR UPDATE OF a`,
        [payload.appId, payload.workspaceId],
      );
      if (appResult.rowCount === 0) throw new Error("App not found in requested workspace");
      app = appResult.rows[0];

      const existing = await db.query(`SELECT * FROM app_deletions WHERE app_id=$1`, [payload.appId]);
      if (existing.rowCount === 1) {
        const deletion = existing.rows[0];
        if (deletion.deletion_key !== payload.deletionKey) throw new Error("Deletion key does not match existing deletion request");
        if (deletion.status === "COMPLETED") {
          await db.query("COMMIT");
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
      if (deletion.provider_project_id) {
        const localOwners = await db.query(
          `SELECT app_id, provider_project_id FROM app_runtimes WHERE provider=$1 AND provider_project_id=$2`,
          [deletion.provider, deletion.provider_project_id],
        );
        assertProviderProjectNotOwnedByAnotherApp(localOwners.rows, {
          appId: payload.appId,
          providerProjectId: deletion.provider_project_id,
        });
      }

      await db.query(`UPDATE app_deletions SET status='DELETING', error_code=NULL, error_message=NULL, updated_at=now() WHERE app_id=$1`, [payload.appId]);
      await db.query(`UPDATE deployments SET status='DELETING', updated_at=now() WHERE app_id=$1 AND status <> 'DELETED'`, [payload.appId]);
      await db.query("COMMIT");

      const databaseDeletion = await deleteManagedDatabaseForApp(db, {
        workspaceId: payload.workspaceId,
        appId: payload.appId,
        getProject: getNeonProject,
        deleteProject: deleteNeonProject,
        listProjectsByName: listNeonProjectsByName,
      });

      if (deletion.provider_project_id) {
        if (deletion.provider !== "vercel") throw new Error(`Unsupported deletion provider: ${deletion.provider}`);
        const remoteProject = await getVercelProject(deletion.provider_project_id);
        if (remoteProject) {
          assertRemoteProjectMatchesSscApp(remoteProject, {
            workspaceId: payload.workspaceId,
            appId: payload.appId,
            slug: app.slug,
            storedProjectName: app.provider_project_name,
            allowLegacyStoredBinding: true,
          });
        }
        await deleteVercelProject(deletion.provider_project_id);
      }

      await db.query(`UPDATE app_deletions SET status='PROVIDER_DELETED', provider_deleted_at=COALESCE(provider_deleted_at,now()), updated_at=now() WHERE app_id=$1`, [payload.appId]);

      await db.query("BEGIN");
      try {
        // deployment_secret_applications reference app_secret_bindings with ON DELETE CASCADE,
        // so deleting the app-scoped bindings safely removes their application records too.
        await db.query(`DELETE FROM app_secret_bindings WHERE app_id=$1`, [payload.appId]);
        await db.query(`DELETE FROM app_runtimes WHERE app_id=$1`, [payload.appId]);
        await db.query(`UPDATE app_databases SET connection_secret_id=NULL, updated_at=now() WHERE app_id=$1`, [payload.appId]);
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
        databaseDeletion,
        secretsDeleted: true,
        runtimeBindingDeleted: true,
        status: "COMPLETED",
      };
    } catch (error: any) {
      try { await db.query("ROLLBACK"); } catch {}
      try {
        await db.query(`UPDATE app_deletions SET status='FAILED', error_code='APP_DELETION_FAILED', error_message=$1, updated_at=now() WHERE app_id=$2 AND deletion_key=$3`, [String(error?.message ?? "App deletion failed").slice(0, 1000), payload.appId, payload.deletionKey]);
      } catch {}
      throw error;
    } finally {
      await db.end();
    }
  },
});
