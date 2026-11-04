import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createOAuthState,
  githubAuthorizationUrl,
  githubRedirectUri,
} from "@/src/server/github-oauth.mjs";
import { oauthStateCookieName, returnToCookieName, stateCookieOptions } from "@/src/server/session.mjs";
import { safeReturnTo } from "@/src/server/mcp-registration.mjs";
import { connectDatabase } from "@/src/server/db.mjs";
import { recognisedClient } from "@/src/server/mcp-recognised-clients.mjs";
import { funnelClientLabel, recordFunnelStep } from "@/src/server/mcp-funnel.mjs";

// Counts a sign-in that started from the MCP connect flow. Never blocks or
// breaks the sign-in itself.
async function countMcpSignIn(returnTo) {
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

export const dynamic = "force-dynamic";

export async function GET(request) {
  const state = createOAuthState();
  const redirectUri = githubRedirectUri(request);
  const store = await cookies();
  store.set(oauthStateCookieName, state, stateCookieOptions());
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return_to"));
  if (returnTo) store.set(returnToCookieName, returnTo, stateCookieOptions());
  await countMcpSignIn(returnTo);
  redirect(githubAuthorizationUrl({ state, redirectUri }).toString());
}
