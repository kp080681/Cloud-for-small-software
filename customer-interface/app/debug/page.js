import { getCustomerShell } from "@/src/server/customer-shell.mjs";
import { connectDatabase } from "@/src/server/db.mjs";
import { loadDeploymentsDebug } from "@/src/server/deployments-debug.mjs";

export const dynamic = "force-dynamic";

// One-click, human-readable version of the deployments-debug admin API --
// no workspace ID to find or paste, no JSON to copy out of a browser tab.
// Resolves the signed-in customer's own current workspace the same way the
// homepage does, then shows exactly what the database says about every
// app's latest deployment: status, live URL (or why there isn't one yet),
// and the event trail. Read-only, no provider credential touched.
export default async function DebugPage() {
  const shell = await getCustomerShell();
  if (!shell.authenticated) {
    return (
      <main style={{ padding: 32, fontFamily: "ui-sans-serif, system-ui" }}>
        <p>Sign in first, then come back to this page.</p>
        <a href="/">Go to sign in</a>
      </main>
    );
  }

  const workspaceId = shell.currentWorkspace.id;
  const db = await connectDatabase();
  let debug;
  try {
    debug = await loadDeploymentsDebug(db, { customerId: shell.user.id, workspaceId });
  } finally {
    await db.end();
  }

  const eventsByDeployment = new Map();
  for (const event of debug.deploymentEvents) {
    const list = eventsByDeployment.get(event.deployment_id) ?? [];
    list.push(event);
    eventsByDeployment.set(event.deployment_id, list);
  }
  const orchestratorByDeployment = new Map(
    debug.orchestratorRunStatuses.map((status) => [status.deploymentId, status]),
  );
  const deploymentByApp = new Map(debug.latestDeployments.map((d) => [d.app_id, d]));

  return (
    <main style={{ padding: "28px", maxWidth: 920, margin: "0 auto", fontFamily: "ui-sans-serif, system-ui", color: "var(--ink)" }}>
      <p style={{ marginBottom: 4 }}>
        <a href="/">&larr; Back to Applications</a>
      </p>
      <h1 style={{ marginBottom: 4 }}>Deployment status (debug)</h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        Workspace: {shell.currentWorkspace.name} &middot; checked {new Date(debug.now).toLocaleString()}
      </p>

      {debug.apps.length === 0 ? <p>No apps in this workspace yet.</p> : null}

      {debug.apps.map((app) => {
        const deployment = deploymentByApp.get(app.id);
        const events = deployment ? eventsByDeployment.get(deployment.id) ?? [] : [];
        const orchestrator = deployment ? orchestratorByDeployment.get(deployment.id) : null;
        return (
          <section
            key={app.id}
            style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 16, marginBottom: 16 }}
          >
            <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>{app.name} <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 14 }}>({app.slug})</span></h2>

            {!deployment ? (
              <p style={{ color: "var(--muted)" }}>No deployments yet.</p>
            ) : (
              <>
                <p style={{ margin: "0 0 6px" }}>
                  <strong>Status:</strong> {deployment.status}
                  {deployment.error_code ? <> &middot; <strong>Error:</strong> {deployment.error_code}</> : null}
                </p>
                <p style={{ margin: "0 0 6px" }}>
                  <strong>Live URL:</strong>{" "}
                  {deployment.live_url ? (
                    <a href={deployment.live_url} target="_blank" rel="noreferrer">{deployment.live_url}</a>
                  ) : (
                    <span style={{ color: "var(--warn)" }}>
                      none yet {deployment.status === "LIVE" ? "(status says LIVE but live_url is empty -- that's a real bug, screenshot this)" : `(deployment is ${deployment.status}, not LIVE)`}
                    </span>
                  )}
                </p>
                {deployment.error_message ? (
                  <p style={{ margin: "0 0 6px", color: "var(--warn)" }}>{deployment.error_message}</p>
                ) : null}
                {orchestrator?.errorMessage ? (
                  <p style={{ margin: "0 0 6px", color: "var(--warn)" }}>Orchestrator: {orchestrator.errorMessage}</p>
                ) : null}

                {events.length ? (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: "pointer", color: "var(--muted)" }}>Recent events ({events.length})</summary>
                    <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, color: "var(--muted)" }}>
                      {events.slice(0, 15).map((event, index) => (
                        <li key={index}>
                          {new Date(event.created_at).toLocaleTimeString()} &middot; {event.event_type}
                          {event.message ? ` -- ${event.message}` : ""}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            )}
          </section>
        );
      })}
    </main>
  );
}
