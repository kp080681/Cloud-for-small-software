import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { getAuthorizedWorkspace } from "@/src/server/customer-workspaces.mjs";
import { describeOrchestratorFailure } from "@/src/server/customer-deployments.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

// Temporary, read-only operator diagnostic: every app in this workspace with
// its latest deployment and that deployment's event trail, in one call, so a
// "still stuck" report can be checked directly instead of going back and
// forth per app. Deliberately touches no provider credential of any kind —
// DB state only — so it can't regress the credential-isolation boundary the
// previous version of this route accidentally tripped. Safe to delete once
// this round of "deployments aren't progressing" is resolved.
export async function GET(request, { params }) {
  let db;
  try {
    const { workspaceId } = await params;
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    await getAuthorizedWorkspace(db, { customerId: session.customerId, workspaceId });

    const apps = await db.query(
      `SELECT id, name, slug, framework, runtime, deleted_at, created_at, updated_at
         FROM apps
        WHERE workspace_id = $1
        ORDER BY created_at DESC`,
      [workspaceId],
    );
    const appIds = apps.rows.map((a) => a.id);

    let latestDeployments = [];
    let events = [];
    if (appIds.length) {
      const deploymentsResult = await db.query(
        `SELECT DISTINCT ON (app_id)
                id, app_id, deployment_key, source_commit_sha, source_branch, status,
                error_code, error_message, orchestrator_run_id, created_at, updated_at
           FROM deployments
          WHERE app_id = ANY($1::uuid[])
          ORDER BY app_id, created_at DESC`,
        [appIds],
      );
      latestDeployments = deploymentsResult.rows;

      const deploymentIds = latestDeployments.map((d) => d.id);
      if (deploymentIds.length) {
        const eventsResult = await db.query(
          `SELECT deployment_id, from_status, to_status, event_type, message, metadata, created_at
             FROM deployment_events
            WHERE deployment_id = ANY($1::uuid[])
            ORDER BY created_at DESC
            LIMIT 100`,
          [deploymentIds],
        );
        events = eventsResult.rows;
      }
    }

    const orchestratorRunStatuses = await Promise.all(
      latestDeployments
        .filter((d) => d.orchestrator_run_id)
        .map(async (d) => ({
          appId: d.app_id,
          deploymentId: d.id,
          ...(await describeOrchestratorFailure(db, {
            customerId: session.customerId,
            workspaceId,
            appId: d.app_id,
            deploymentId: d.id,
          })),
        })),
    );

    return Response.json({
      now: new Date().toISOString(),
      apps: apps.rows,
      latestDeployments,
      deploymentEvents: events,
      orchestratorRunStatuses,
    });
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
