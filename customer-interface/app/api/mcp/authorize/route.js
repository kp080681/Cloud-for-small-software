import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { ensureInitialWorkspace, defaultWorkspaceName } from "@/src/server/customer-workspaces.mjs";
import { selectedWorkspaceCookieName } from "@/src/server/session.mjs";
import { createAuthorizationCode, resolveMcpClient } from "@/src/server/mcp-auth.mjs";

export const dynamic = "force-dynamic";

// Standard OAuth 2.1 authorization endpoint. Reachable only by an
// already-authenticated customer (the existing cookie session, same as
// every other page) — an MCP client that isn't logged in gets redirected
// through the normal sign-in flow first, not handled specially here.
//
// No consent screen yet, by design and noted explicitly rather than
// silently skipped: for v1, an authenticated customer using their own
// already-connected AI platform is treated as sufficient authorization —
// matching the platform's zero-config default. A future explicit
// "<client> wants access to <workspace> — Allow / Deny" screen is a UI
// task, not this item's scope.
export async function GET(request) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "S256";
  const state = url.searchParams.get("state");
  const responseType = url.searchParams.get("response_type");

  if (responseType !== "code" || !clientId || !redirectUri || !codeChallenge) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  let db;
  // Set only once client_id + redirect_uri have been validated against the
  // registered allowlist. Until then, errors must never redirect anywhere:
  // redirecting to an unvalidated redirect_uri is an open redirect
  // (RFC 6749 §4.1.2.1).
  let redirectUriTrusted = false;
  try {
    db = await connectDatabase();

    // Validate client_id + redirect_uri FIRST, before requiring a session
    // at all — an independent review (Opus 5.5) suggested this ordering:
    // a malformed or unregistered request should get a clean 4xx
    // immediately, rather than first forcing a logged-out visitor through
    // a 401 for a request that was never going to succeed anyway.
    await resolveMcpClient(db, { clientId, redirectUri });
    redirectUriTrusted = true;

    const session = await requireCustomerSession(await cookies());

    const initialWorkspace = await ensureInitialWorkspace(db, {
      customerId: session.customerId,
      workspaceName: defaultWorkspaceName(session),
    });
    const cookieWorkspaceId = (await cookies()).get(selectedWorkspaceCookieName)?.value;
    const workspaceId = cookieWorkspaceId || initialWorkspace.id;

    const { code } = await createAuthorizationCode(db, {
      customerId: session.customerId,
      workspaceId,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
    });

    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    return Response.redirect(target);
  } catch (error) {
    if (error?.status === 401) {
      // Not logged in. Deliberately NOT chaining through the login flow and
      // back automatically here — that would mean modifying the existing,
      // already-proven GitHub OAuth login flow (a different, security-
      // sensitive piece of code) to carry a return-to path, which needs its
      // own careful open-redirect validation and its own review, not a
      // bolt-on inside this item. For now: a direct, honest error. The
      // real-world flow is "log into Utplava first, then have your MCP
      // client retry" — a one-time inconvenience, not a broken feature.
      return Response.json(
        { error: "login_required", message: "Sign in to Utplava first, then retry authorization." },
        { status: 401 },
      );
    }
    if (!redirectUriTrusted) {
      // redirect_uri itself could not be confirmed safe (unknown client,
      // or redirect_uri not on that client's allowlist) — never redirect
      // the browser anywhere in this case, per RFC 6749 §4.1.2.1. Report
      // the error directly instead.
      return Response.json(
        { error: error?.code ? error.code.toLowerCase() : "invalid_request", message: error?.message || "Authorization request is invalid." },
        { status: Number.isInteger(error?.status) ? error.status : 400 },
      );
    }
    // redirectUri is confirmed safe at this point — any error from here
    // (workspace not found, invalid PKCE parameters) is safe to report by
    // redirecting back to the client's own registered callback, using the
    // actual OAuth error vocabulary (RFC 6749 §4.1.2.1) rather than a
    // blanket server_error for everything — a refinement suggested by an
    // independent review (Opus 5.5).
    const target = new URL(redirectUri);
    const oauthError = typeof error?.code === "string" && error.code.startsWith("INVALID_CODE_CHALLENGE") ? "invalid_request" : "server_error";
    target.searchParams.set("error", oauthError);
    if (state) target.searchParams.set("state", state);
    return Response.redirect(target);
  } finally {
    if (db) await db.end();
  }
}
