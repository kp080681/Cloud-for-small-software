import { connectDatabase } from "./db.mjs";
import { recognisedClient } from "./mcp-recognised-clients.mjs";
import { funnelClientLabel, recordFunnelStep } from "./mcp-funnel.mjs";

// Counts a sign-in that started from the MCP connect flow. Never blocks or
// breaks the sign-in itself.
export async function countMcpSignIn(returnTo) {
  if (!returnTo || !returnTo.startsWith("/api/mcp/authorize?")) return;
  let db;
  try {
    const params = new URL(returnTo, "https://utplava.invalid").searchParams;
    const clientId = params.get("client_id");
    const redirectUri = params.get("redirect_uri");
    if (!clientId) return;
    db = await connectDatabase();
    const found = await db.query("SELECT name FROM mcp_clients WHERE client_id = $1", [clientId]);
    const known = redirectUri ? recognisedClient(redirectUri) : null;
    await recordFunnelStep(db, {
      step: "signin_started",
      client: funnelClientLabel({ recognisedLabel: known?.kind === "hosted" ? known.label : null, clientName: found.rows[0]?.name }),
    });
  } catch {
    // Counting is best-effort.
  } finally {
    if (db) await db.end().catch(() => {});
  }
}

