import crypto from "node:crypto";
import { getAuthorizedWorkspace } from "./customer-workspaces.mjs";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  expiresAtFromNow,
  generateOpaqueToken,
  hashToken,
  isAllowedRedirectUri,
  isExpired,
  verifyPkceChallenge,
} from "../shared/control-plane/mcp-auth-crypto.mjs";

export class McpAuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "McpAuthError";
    this.code = code;
    this.status = status;
  }
}

export async function resolveMcpClient(db, { clientId, redirectUri }) {
  const result = await db.query(
    `SELECT id, client_id, name, redirect_uris, disabled_at FROM mcp_clients WHERE client_id=$1`,
    [clientId],
  );
  const client = result.rows[0];
  if (!client || client.disabled_at) throw new McpAuthError("INVALID_CLIENT", "Unknown or disabled MCP client.", 400);
  if (!isAllowedRedirectUri({ redirectUri, allowedUris: client.redirect_uris })) {
    throw new McpAuthError("INVALID_REDIRECT_URI", "redirect_uri is not registered for this client.", 400);
  }
  return client;
}

// Called only from a route the existing cookie-authenticated web session
// reaches (customerId comes from that session, never from the request
// body) — an MCP client never talks to this function directly, only to the
// authorization endpoint's redirect and the token endpoint below.
export async function createAuthorizationCode(
  db,
  { customerId, workspaceId, clientId, redirectUri, codeChallenge, codeChallengeMethod = "S256" },
) {
  if (codeChallengeMethod !== "S256") {
    throw new McpAuthError("INVALID_CODE_CHALLENGE_METHOD", "Only S256 is supported.", 400);
  }
  if (typeof codeChallenge !== "string" || codeChallenge.length < 43) {
    throw new McpAuthError("INVALID_CODE_CHALLENGE", "code_challenge is required.", 400);
  }

  const client = await resolveMcpClient(db, { clientId, redirectUri });
  // Reuses the exact same tenant-boundary function the rest of the web app
  // uses for every workspace-scoped page — a customer cannot mint an MCP
  // grant for a workspace they don't belong to, for the same reason and by
  // the same code path they can't open that workspace's dashboard. This is
  // the literal ask of item 8: reuse existing tenant-boundary code, not
  // reimplement a parallel check.
  await getAuthorizedWorkspace(db, { customerId, workspaceId });

  const code = generateOpaqueToken();
  await db.query(
    `INSERT INTO mcp_authorization_codes
       (code_hash, mcp_client_id, customer_identity_id, workspace_id, redirect_uri, code_challenge, code_challenge_method, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      hashToken(code),
      client.id,
      customerId,
      workspaceId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      expiresAtFromNow(AUTHORIZATION_CODE_TTL_SECONDS),
    ],
  );
  return { code, redirectUri };
}

async function issueTokenPair(db, { clientId, customerId, workspaceId, tokenFamilyId }) {
  const accessToken = generateOpaqueToken();
  const refreshToken = generateOpaqueToken();
  await db.query(
    `INSERT INTO mcp_tokens
       (token_family_id, mcp_client_id, customer_identity_id, workspace_id,
        access_token_hash, access_token_expires_at, refresh_token_hash, refresh_token_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      tokenFamilyId,
      clientId,
      customerId,
      workspaceId,
      hashToken(accessToken),
      expiresAtFromNow(ACCESS_TOKEN_TTL_SECONDS),
      hashToken(refreshToken),
      expiresAtFromNow(REFRESH_TOKEN_TTL_SECONDS),
    ],
  );
  return { accessToken, refreshToken, tokenType: "Bearer", expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

// The token endpoint's authorization_code grant. codeVerifier comes from
// the MCP client (the thing it kept secret since the authorization
// request); everything else here is re-derived from what was stored at
// authorization time, never trusted from this request alone.
export async function exchangeAuthorizationCode(db, { code, clientId, redirectUri, codeVerifier }) {
  const client = await resolveMcpClient(db, { clientId, redirectUri });

  // Atomic single-use claim — the exact compare-and-swap pattern already
  // proven in provider-mutation-fencing.mjs (conditional UPDATE + rowCount
  // check), not a read-then-write race that a concurrent double-exchange
  // could slip through.
  const claimed = await db.query(
    `UPDATE mcp_authorization_codes
        SET used_at = now()
      WHERE code_hash = $1
        AND mcp_client_id = $2
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING id, customer_identity_id, workspace_id, redirect_uri, code_challenge, code_challenge_method`,
    [hashToken(code), client.id],
  );
  if (claimed.rowCount === 0) {
    throw new McpAuthError("INVALID_GRANT", "Authorization code is invalid, expired, or already used.", 400);
  }
  const grant = claimed.rows[0];

  // redirect_uri must match exactly what was used at authorization time —
  // not just be on the client's allowlist again. Closes the
  // authorization-code-injection class of attack where a code issued for
  // one redirect_uri is redeemed against a different one.
  if (grant.redirect_uri !== redirectUri) {
    throw new McpAuthError("INVALID_GRANT", "redirect_uri does not match the authorization request.", 400);
  }
  if (!verifyPkceChallenge({ verifier: codeVerifier, challenge: grant.code_challenge, method: grant.code_challenge_method })) {
    throw new McpAuthError("INVALID_GRANT", "PKCE verification failed.", 400);
  }

  return issueTokenPair(db, {
    clientId: client.id,
    customerId: grant.customer_identity_id,
    workspaceId: grant.workspace_id,
    tokenFamilyId: crypto.randomUUID(),
  });
}

// The actual per-tool-call authentication entrypoint a future MCP server
// (item 9) calls before running deploy/get_status/etc — the MCP-transport
// analogue of requireCustomerSession for the cookie-based web session.
export async function verifyAccessToken(db, { accessToken }) {
  if (typeof accessToken !== "string" || !accessToken) {
    throw new McpAuthError("INVALID_TOKEN", "Access token is required.", 401);
  }
  const result = await db.query(
    `SELECT customer_identity_id, workspace_id, mcp_client_id, access_token_expires_at, revoked_at
       FROM mcp_tokens WHERE access_token_hash=$1`,
    [hashToken(accessToken)],
  );
  const row = result.rows[0];
  if (!row || row.revoked_at || isExpired(row.access_token_expires_at)) {
    throw new McpAuthError("INVALID_TOKEN", "Access token is invalid, revoked, or expired.", 401);
  }
  return { customerId: row.customer_identity_id, workspaceId: row.workspace_id, mcpClientId: row.mcp_client_id };
}

// The token endpoint's refresh_token grant, with rotation and reuse
// detection (RFC 6819 §5.2.2.3 / the pattern most production OAuth
// providers use for public clients that can't hold a secret).
export async function rotateRefreshToken(db, { refreshToken, clientId }) {
  const clientResult = await db.query(`SELECT id FROM mcp_clients WHERE client_id=$1 AND disabled_at IS NULL`, [clientId]);
  if (clientResult.rowCount === 0) throw new McpAuthError("INVALID_CLIENT", "Unknown or disabled MCP client.", 400);
  const client = clientResult.rows[0];

  const result = await db.query(
    `SELECT id, token_family_id, customer_identity_id, workspace_id, mcp_client_id, refresh_token_expires_at, rotated_at, revoked_at
       FROM mcp_tokens WHERE refresh_token_hash=$1`,
    [hashToken(refreshToken)],
  );
  const row = result.rows[0];
  if (!row || row.mcp_client_id !== client.id) {
    throw new McpAuthError("INVALID_GRANT", "Refresh token is invalid.", 400);
  }
  if (row.rotated_at) {
    // Reuse of an already-rotated refresh token is a signal the token was
    // stolen and both the legitimate holder and an attacker are now
    // presenting it — revoke the entire family rather than just this
    // token, forcing a fresh authorization rather than trusting anything
    // downstream of a possible compromise.
    await db.query(
      `UPDATE mcp_tokens SET revoked_at = now() WHERE token_family_id = $1 AND revoked_at IS NULL`,
      [row.token_family_id],
    );
    throw new McpAuthError(
      "REUSE_DETECTED",
      "This refresh token was already used. All tokens in this session have been revoked; please re-authorize.",
      400,
    );
  }
  if (row.revoked_at || isExpired(row.refresh_token_expires_at)) {
    throw new McpAuthError("INVALID_GRANT", "Refresh token is revoked or expired.", 400);
  }

  await db.query(`UPDATE mcp_tokens SET rotated_at = now() WHERE id = $1`, [row.id]);
  return issueTokenPair(db, {
    clientId: row.mcp_client_id,
    customerId: row.customer_identity_id,
    workspaceId: row.workspace_id,
    tokenFamilyId: row.token_family_id,
  });
}

// Customer-facing revoke — tenant-scoped the same way every other mutating
// customer-interface function is: a customer can only revoke a family that
// is actually theirs, for their workspace.
export async function revokeTokenFamily(db, { customerId, workspaceId, tokenFamilyId }) {
  const result = await db.query(
    `UPDATE mcp_tokens SET revoked_at = now()
      WHERE token_family_id = $1 AND customer_identity_id = $2 AND workspace_id = $3 AND revoked_at IS NULL`,
    [tokenFamilyId, customerId, workspaceId],
  );
  return { revokedCount: result.rowCount };
}
