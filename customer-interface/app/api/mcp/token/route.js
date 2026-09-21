import { connectDatabase } from "@/src/server/db.mjs";
import { exchangeAuthorizationCode, rotateRefreshToken } from "@/src/server/mcp-auth.mjs";

export const dynamic = "force-dynamic";

// Standard OAuth 2.1 token endpoint. Handles both grant types MCP clients
// need: authorization_code (first exchange, with PKCE) and refresh_token
// (silent renewal, with rotation + reuse detection). No cookie session
// involved here at all — everything needed to authenticate the request is
// in the POST body itself, exactly like a real OAuth token endpoint.
export async function POST(request) {
  let db;
  try {
    const body = await request.json().catch(() => ({}));
    db = await connectDatabase();

    if (body.grant_type === "authorization_code") {
      const tokens = await exchangeAuthorizationCode(db, {
        code: body.code,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
      });
      return Response.json(toOAuthResponse(tokens));
    }

    if (body.grant_type === "refresh_token") {
      const tokens = await rotateRefreshToken(db, {
        refreshToken: body.refresh_token,
        clientId: body.client_id,
      });
      return Response.json(toOAuthResponse(tokens));
    }

    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const code = typeof error?.code === "string" ? error.code : "SERVER_ERROR";
    return Response.json({ error: code.toLowerCase() }, { status });
  } finally {
    if (db) await db.end();
  }
}

// Field names an OAuth client actually expects (snake_case, RFC 6749 §5.1)
// — mcp-auth.mjs's own return shape is camelCase, matching the rest of this
// codebase's JS conventions; this is the one place that translates between
// the two, kept deliberately thin.
function toOAuthResponse(tokens) {
  return {
    access_token: tokens.accessToken,
    token_type: tokens.tokenType,
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
  };
}
