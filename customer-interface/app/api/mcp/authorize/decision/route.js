import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { requireCustomerSession } from "@/src/server/customer-shell.mjs";
import { createAuthorizationCode, resolveMcpClient } from "@/src/server/mcp-auth.mjs";

export const dynamic = "force-dynamic";

// Handles the customer's Allow/Deny choice from /mcp/consent. This is the
// only place an authorization code is actually minted — the consent page
// itself never creates one, it only renders what /api/mcp/authorize
// resolved. Every security-relevant check (client/redirect_uri validity,
// workspace ownership) is repeated here rather than trusted from the
// consent page's query string or form fields, the same "never trust a
// redirect's own parameters as already-verified" discipline the original
// /api/mcp/authorize endpoint already follows.
export async function POST(request) {
  const form = await request.formData();
  const clientId = form.get("client_id");
  const redirectUri = form.get("redirect_uri");
  const codeChallenge = form.get("code_challenge");
  const codeChallengeMethod = form.get("code_challenge_method") || "S256";
  const workspaceId = form.get("workspace_id");
  const state = form.get("state");
  const decision = form.get("decision");

  if (typeof clientId !== "string" || typeof redirectUri !== "string" || !clientId || !redirectUri) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  let db;
  // Same open-redirect discipline as /api/mcp/authorize: never redirect
  // anywhere, including a "denied" redirect, until client_id + redirect_uri
  // have been confirmed against the registered allowlist.
  let redirectUriTrusted = false;
  try {
    db = await connectDatabase();
    await resolveMcpClient(db, { clientId, redirectUri });
    redirectUriTrusted = true;

    const session = await requireCustomerSession(await cookies());

    if (decision !== "allow") {
      const target = new URL(redirectUri);
      target.searchParams.set("error", "access_denied");
      if (typeof state === "string" && state) target.searchParams.set("state", state);
      return Response.redirect(target);
    }

    if (typeof codeChallenge !== "string" || typeof workspaceId !== "string" || !codeChallenge || !workspaceId) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

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
    if (typeof state === "string" && state) target.searchParams.set("state", state);
    return Response.redirect(target);
  } catch (error) {
    if (error?.status === 401) {
      return Response.json(
        { error: "login_required", message: "Sign in to Utplava first, then retry authorization." },
        { status: 401 },
      );
    }
    if (!redirectUriTrusted) {
      return Response.json(
        { error: error?.code ? error.code.toLowerCase() : "invalid_request", message: error?.message || "Authorization request is invalid." },
        { status: Number.isInteger(error?.status) ? error.status : 400 },
      );
    }
    const target = new URL(redirectUri);
    const oauthError = typeof error?.code === "string" && error.code.startsWith("INVALID_CODE_CHALLENGE") ? "invalid_request" : "server_error";
    target.searchParams.set("error", oauthError);
    if (typeof state === "string" && state) target.searchParams.set("state", state);
    return Response.redirect(target);
  } finally {
    if (db) await db.end();
  }
}
