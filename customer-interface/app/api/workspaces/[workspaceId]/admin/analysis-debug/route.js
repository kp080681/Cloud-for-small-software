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
        `SELECT id, app_id, deployment_key, source_commit_sha, source_branch, status, error_code, error_message, orchestrator_run_id, created_at, updated_at
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

    // Trigger.dev enqueues a run and hands back a run id immediately, which
    // only proves the orchestrator task was accepted into the queue — not
    // that it ran, finished, or succeeded. Nothing in our own database is
    // updated if the run itself fails inside Trigger.dev, so the only way to
    // tell what actually happened to a given run is to ask Trigger.dev
    // directly, using this app's own already-configured TRIGGER_SECRET_KEY.
    let runStatuses = null;
    if (new URL(request.url).searchParams.get("runStatus")) {
      const secret = process.env.TRIGGER_SECRET_KEY;
      const baseUrl = (process.env.TRIGGER_API_URL || "https://api.trigger.dev").replace(/\/$/, "");
      const runIds = [...new Set(deployments.map((d) => d.orchestrator_run_id).filter(Boolean))].slice(0, 5);
      if (!secret) {
        runStatuses = { error: "TRIGGER_SECRET_KEY_NOT_SET_IN_THIS_RUNTIME" };
      } else if (!runIds.length) {
        runStatuses = { error: "NO_ORCHESTRATOR_RUN_ID_RECORDED" };
      } else {
        runStatuses = await Promise.all(
          runIds.map(async (runId) => {
            try {
              const res = await fetch(`${baseUrl}/api/v3/runs/${encodeURIComponent(runId)}`, {
                headers: { Authorization: `Bearer ${secret}` },
              });
              const body = await res.json().catch(() => ({}));
              return { runId, httpStatus: res.status, body };
            } catch (error) {
              return { runId, error: String(error?.message || error) };
            }
          }),
        );
      }
    }

    return Response.json({
      now: new Date().toISOString(),
      apps: relevantApps,
      deployments,
      deploymentEvents: events,
      repositoryAnalysisRateLimit: rateLimit.rows,
      runStatuses,
    });
  } catch (error) {
    return safeErrorResponse(error);
  } finally {
    if (db) await db.end();
  }
}
