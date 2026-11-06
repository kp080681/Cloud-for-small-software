import { SignInOptions } from "../../sign-in-options.js";
import { redirect } from "next/navigation";
import { readCurrentSession } from "@/src/server/customer-shell.mjs";
import { connectDatabase } from "@/src/server/db.mjs";
import { resolveMcpClient } from "@/src/server/mcp-auth.mjs";
import { safeReturnTo } from "@/src/server/mcp-registration.mjs";
import { recognisedClient } from "@/src/server/mcp-recognised-clients.mjs";
import { funnelClientLabel, recordFunnelStep } from "@/src/server/mcp-funnel.mjs";

export const dynamic = "force-dynamic";

// Welcome page for people who arrive from an AI tool or an MCP directory
// (Glama, Rayrun, Claude...) without a Utplava account (2026-10-31).
// /api/mcp/authorize sends signed-out visitors here instead of straight to
// GitHub's authorize screen, which strangers abandoned without knowing what
// Utplava is. This page grants nothing: its only button starts the normal
// GitHub sign-in with a return path that safeReturnTo limits to
// /api/mcp/authorize, which then repeats every check and still shows the
// consent screen (with its unrecognised-app warning) before any access.

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect className="mark-tile" x="0.5" y="0.5" width="23" height="23" rx="5.4" />
      <line className="mark-horizon" x1="3.75" y1="16.4" x2="20.25" y2="16.4" />
      <path className="mark-sun" d="M 5,16.4 A 7,7 0 0 1 19,16.4 Z" />
    </svg>
  );
}

function Problem() {
  return (
    <main className="sign-in">
      <div className="brand">
        <Mark />
        utplava
      </div>
      <section className="panel">
        <h2>This connection link isn&apos;t complete.</h2>
        <p className="muted">Go back to the app or tool you came from and start connecting Utplava again.</p>
        <a className="button" href="https://utplava.dev">What is Utplava?</a>
      </section>
    </main>
  );
}

export default async function McpWelcomePage({ searchParams }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) if (typeof value === "string") query.set(key, value);
  const clientId = query.get("client_id");
  const redirectUri = query.get("redirect_uri");
  const returnTo = safeReturnTo(`/api/mcp/authorize?${query.toString()}`);
  if (!clientId || !redirectUri || !query.get("code_challenge") || !returnTo) return <Problem />;

  // Already signed in (for example in another tab): carry straight on.
  if (await readCurrentSession()) redirect(returnTo);

  let client = null;
  let db;
  try {
    db = await connectDatabase();
    client = await resolveMcpClient(db, { clientId, redirectUri });
    const known = recognisedClient(redirectUri);
    await recordFunnelStep(db, {
      step: "welcome_viewed",
      client: funnelClientLabel({ recognisedLabel: known?.kind === "hosted" ? known.label : null, clientName: client.name }),
    });
  } catch {
    client = null;
  } finally {
    if (db) await db.end();
  }
  if (!client) return <Problem />;

  // The registered name is self-reported, so a known tool is named from its
  // return address instead; anything else is shown as "an app called ...".
  const recognised = recognisedClient(redirectUri);
  const named = recognised?.kind === "hosted" ? recognised.label : null;
  const who = named || client.name;

  return (
    <main className="sign-in">
      <div className="brand">
        <Mark />
        utplava
      </div>
      <section className="panel welcome-panel">
        <p className="welcome-from">
          {named ? <>{named} wants to connect to Utplava</> : <>An app called &ldquo;{client.name}&rdquo; wants to connect to Utplava</>}
        </p>
        <h2>Put your apps online, straight from {who}</h2>
        <p className="muted">
          Utplava puts your app live on its own link, or your own domain. Once connected, {who} can put apps online, update
          them and check on them when you ask, straight from the files in your chat or from GitHub.
        </p>
        <ul className="welcome-points">
          <li><strong>Free to start.</strong> 3 apps and a database, no card needed.</li>
          <li><strong>No GitHub needed.</strong> {who} can send your app&apos;s files to Utplava directly.</li>
          <li><strong>Sign in with Google or GitHub.</strong> Utplava never sees your password.</li>
          <li><strong>Nothing is shared yet.</strong> Next you&apos;ll see exactly what {who} can do, and you can say no.</li>
        </ul>
        <SignInOptions returnTo={returnTo} />
        <p className="helptext">
          New here? <a href="https://utplava.dev" target="_blank" rel="noreferrer">See what Utplava is</a> or read how it
          keeps your apps <a href="https://utplava.dev/security/" target="_blank" rel="noreferrer">safe</a>.
        </p>
      </section>
    </main>
  );
}
