import { connectDatabase } from "@/src/server/db.mjs";
import { exchangeAuthorizationCode, rotateRefreshToken } from "@/src/server/mcp-auth.mjs";
import { clientLabelFor, recordFunnelStep } from "@/src/server/mcp-funnel.mjs";

export const dynamic = "force-dynamic";

// Standard OAuth 2.1 token endpoint. Handles both grant types MCP clients
// need: authorization_code (first exchange, with PKCE) and refresh_token
// (silent renewal, with rotation + reuse detection). No cookie session
// involved here at all — everything needed to authenticate the request is
// in the POST body itself, exactly like a real OAuth token endpoint.
export async function POST(request) {
  let db;
  let body = {};
  try {
    // RFC 6749 §4.1.3/§6 require clients to send token requests as
    // application/x-www-form-urlencoded, not JSON — real OAuth clients
    // (including standard MCP clients) send form-encoded bodies. An
    // independent review (Opus 5.5) found this endpoint only ever parsed
    // JSON, meaning no compliant client could actually complete a token
    // exchange against it at all.
    const contentType = request.headers.get("content-type") || "";
    body = contentType.includes("application/x-www-form-urlencoded")
      ? Object.fromEntries(new URLSearchParams(await request.text()))
      : await request.json().catch(() => ({}));
    // Confidential clients (033) send their secret either in the form body
    // (client_secret_post) or as HTTP Basic (client_secret_basic, RFC 6749
    // §2.3.1: form-encoded id and secret, base64'd).
    const basic = parseBasicAuth(request.headers.get("authorization"));
    if (basic && body.client_id && body.client_id !== basic.clientId) {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    const clientId = body.client_id || basic?.clientId;
    const clientSecret = body.client_secret || basic?.clientSecret;
    body = { ...body, client_id: clientId };
    db = await connectDatabase();

    if (body.grant_type === "authorization_code") {
      const tokens = await exchangeAuthorizationCode(db, {
        code: body.code,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
        clientSecret,
      });
      await recordFunnelStep(db, { step: "token_issued", client: await clientLabelFor(db, body.client_id) });
      return Response.json(toOAuthResponse(tokens));
    }

    if (body.grant_type === "refresh_token") {
      const tokens = await rotateRefreshToken(db, {
        refreshToken: body.refresh_token,
        clientId: body.client_id,
        clientSecret,
      });
      return Response.json(toOAuthResponse(tokens));
    }

    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  } catch (error) {
    // Only this codebase's own McpAuthError codes are ever surfaced —
    // anything else (a raw Postgres error, a driver-level failure) would
    // otherwise pass its .code/.status straight through, the same class
    // of leak fixed in the tool layer's safeToolErrorMessage.
    const known = error?.name === "McpAuthError";
    const status = known && Number.isInteger(error?.status) ? error.status : 500;
    const code = known ? error.code : "SERVER_ERROR";
    if (db && body?.grant_type !== "refresh_token") {
      const hint = !body?.client_id ? (request.headers.get("authorization") ? "client_id_in_basic_auth" : "no_client_id") : code.toLowerCase();
      await recordFunnelStep(db, { step: "token_rejected", client: `${await clientLabelFor(db, body?.client_id)} (${hint})` });
    }
    const headers = status === 401 ? { "WWW-Authenticate": 'Basic realm="utplava"' } : undefined;
    return Response.json({ error: code.toLowerCase() }, { status, headers });
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

function parseBasicAuth(header) {
  if (typeof header !== "string" || !/^basic\s+/i.test(header)) return null;
  try {
    const decoded = Buffer.from(header.replace(/^basic\s+/i, "").trim(), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 1) return null;
    return {
      clientId: decodeURIComponent(decoded.slice(0, i).replace(/\+/g, " ")),
      clientSecret: decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, " ")),
    };
  } catch {
    return null;
  }
}
