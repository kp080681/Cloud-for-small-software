import { redirect } from "next/navigation";
import { readCurrentSession } from "@/src/server/customer-shell.mjs";
import { getAuthorizedWorkspace } from "@/src/server/customer-workspaces.mjs";
import { connectDatabase } from "@/src/server/db.mjs";
import { resolveMcpClient } from "@/src/server/mcp-auth.mjs";

export const dynamic = "force-dynamic";

// Explicit "<client> wants access to <workspace> — Allow / Deny" consent
// screen. /api/mcp/authorize redirects here instead of minting a code
// itself; this page only decides what to show the customer. The actual
// decision is handled by a plain HTML form posting to
// /api/mcp/authorize/decision, which repeats every check done here (client,
// redirect_uri, workspace ownership) rather than trusting this page's own
// read — a customer could reload or bookmark this URL, or the query string
// could be tampered with in transit, so nothing here is treated as already
// verified by the time the decision route runs.
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="8" width="13" height="13" rx="1.5" />
      <rect x="9" y="1" width="13" height="13" rx="1.5" />
    </svg>
  );
}

function ConsentError({ title, message }) {
  return (
    <main className="sign-in">
      <div className="brand">
        <Mark />
        utplava
      </div>
      <section className="panel">
        <h2>{title}</h2>
        <p className="muted">{message}</p>
      </section>
    </main>
  );
}

export default async function McpConsentPage({ searchParams }) {
  const params = await searchParams;
  const clientId = typeof params?.client_id === "string" ? params.client_id : null;
  const redirectUri = typeof params?.redirect_uri === "string" ? params.redirect_uri : null;
  const codeChallenge = typeof params?.code_challenge === "string" ? params.code_challenge : null;
  const codeChallengeMethod = typeof params?.code_challenge_method === "string" ? params.code_challenge_method : "S256";
  const workspaceId = typeof params?.workspace_id === "string" ? params.workspace_id : null;
  const state = typeof params?.state === "string" ? params.state : null;

  if (!clientId || !redirectUri || !codeChallenge || !workspaceId) {
    return <ConsentError title="This authorization request is incomplete." message="Ask the app or tool you're connecting to start the connection again." />;
  }

  const session = await readCurrentSession();
  if (!session) {
    // Mirrors /api/mcp/authorize: sign in first, then retry from the MCP
    // client rather than chaining through the login flow's own redirect
    // handling here too.
    redirect(`/?mcp_sign_in_required=1`);
  }

  let client;
  let workspace;
  let db;
  try {
    db = await connectDatabase();
    client = await resolveMcpClient(db, { clientId, redirectUri });
    workspace = await getAuthorizedWorkspace(db, { customerId: session.customerId, workspaceId }).catch(() => null);
  } finally {
    if (db) await db.end();
  }

  if (!workspace) {
    return <ConsentError title="This authorization request is invalid." message="Ask the app or tool you're connecting to start the connection again." />;
  }

  return (
    <main className="sign-in">
      <div className="brand">
        <Mark />
        utplava
      </div>
      <section className="panel">
        <h2>Allow {client.name} to access Utplava?</h2>
        <p className="muted">
          {client.name} will be able to see and manage apps in your <strong>{workspace.name}</strong> workspace —
          deploying, checking status, and reading logs — using your Utplava account.
        </p>
        <form action="/api/mcp/authorize/decision" method="post" className="consent-form">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="code_challenge" value={codeChallenge} />
          <input type="hidden" name="code_challenge_method" value={codeChallengeMethod} />
          <input type="hidden" name="workspace_id" value={workspaceId} />
          {state ? <input type="hidden" name="state" value={state} /> : null}
          <button className="button primary" type="submit" name="decision" value="allow">
            Allow
          </button>
          <button className="button" type="submit" name="decision" value="deny">
            Deny
          </button>
        </form>
        <p className="helptext">You can remove access at any time from Connected apps in your workspace.</p>
      </section>
    </main>
  );
}
