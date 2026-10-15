import { describeOrchestratorFailure } from "./customer-deployments.mjs";

// Never the credential itself — host, port and database name only, parsed
// from this runtime's own working connection string, so the value this app
// actually uses can be compared against whatever was pasted into another
// runtime's config without ever exposing the password.
export function workingDatabaseTarget() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return {
      host: parsed.hostname || null,
      port: parsed.port || null,
      database: parsed.pathname.replace(/^\//, "") || null,
    };
  } catch {
    return null;
  }
}

// Shared by the JSON admin route and the human-readable /debug page, so
// there's exactly one place that knows how to answer "what does the
// database actually say about this workspace's deployments right now" --
// read-only, DB state only, no provider credential touched.
export async function loadDeploymentsDebug(db, { customerId, workspaceId }) {
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
              error_code, error_message, live_url, orchestrator_run_id, created_at, updated_at
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
          customerId,
          workspaceId,
          appId: d.app_id,
          deploymentId: d.id,
        })),
      })),
  );

  return {
    now: new Date().toISOString(),
    apps: apps.rows,
    latestDeployments,
    deploymentEvents: events,
    orchestratorRunStatuses,
    thisAppsOwnWorkingDatabaseTarget: workingDatabaseTarget(),
  };
}
