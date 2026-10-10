import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { getAuthorizedWorkspace } from "@/src/server/customer-workspaces.mjs";
import { safeErrorResponse } from "@/src/server/http.mjs";

export const dynamic = "force-dynamic";

// Temporary operator diagnostic: surfaces the server-side state of the most
// recent repository analyses for this workspace — the apps/deployments rows,
// the deployment_events trail, and the repository_analysis rate-limit
// counter — so we can tell whether a request that looks "stuck" client-side
// ever reached the database, finished, or was blocked, without guessing from
// the UI. Safe to delete once the Vantage analysis question is resolved.
export async function GET(request, { params }) {
  let db;
  try {
    const { workspaceId } = await params;
    const session = await requireCustomerSession(await cookies());
    db = await connectDatabase();
    await getAuthorizedWorkspace(db, { customerId: session.customerId, workspaceId });

    const search = new URL(request.url).searchParams.get("q")?.toLowerCase() ?? null;

    const apps = await db.query(
      `SELECT id, name, slug, framework, runtime, database_required, deleted_at, created_at, updated_at
         FROM apps
        WHERE workspace_id = $1
        ORDER BY created_at DESC`,
      [workspaceId],
    );
    const relevantApps = search
      ? apps.rows.filter((a) => a.name?.toLowerCase().includes(search) || a.slug?.toLowerCase().includes(search))
      : apps.rows;
    const appIds = relevantApps.map((a) => a.id);

    let deployments = [];
    let events = [];
    if (appIds.length) {
      const deploymentsResult = await db.query(
        `SELECT id, app_id, deployment_key, source_commit_sha, source_branch, status, error_code, error_message, created_at, updated_at
           FROM deployments
          WHERE app_id = ANY($1::uuid[])
          ORDER BY created_at DESC
          LIMIT 20`,
        [appIds],
      );
      deployments = deploymentsResult.rows;

      const deploymentIds = deployments.slice(0, 5).map((d) => d.id);
      if (deploymentIds.length) {
        const eventsResult = await db.query(
          `SELECT deployment_id, from_status, to_status, event_type, message, metadata, created_at
             FROM deployment_events
            WHERE deployment_id = ANY($1::uuid[])
            ORDER BY created_at DESC
            LIMIT 40`,
          [deploymentIds],
        );
        events = eventsResult.rows;
      }
    }

    const rateLimit = await db.query(
      `SELECT action, window_start, count, updated_at
         FROM workspace_rate_limit_counters
        WHERE workspace_id = $1
          AND action = 'repository_analysis'
        ORDER BY window_start DESC
        LIMIT 5`,
      [workspaceId],
    );

    return Response.json({
      now: new Date().toISOString(),
      apps: relevantApps,
      deployments,
      deploymentEvents: events,
      repositoryAnalysisRateLimit: rateLimit.rows,
    });
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
