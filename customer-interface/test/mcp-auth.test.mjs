import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
  McpAuthError,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  revokeTokenFamily,
  rotateRefreshToken,
  verifyAccessToken,
} from "../src/server/mcp-auth.mjs";

function realPkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

class FakeDb {
  constructor() {
    this.memberships = [{ customerId: "identity-a", workspaceId: "workspace-a" }];
    this.workspaces = [{ id: "workspace-a", name: "A" }];
    this.clients = [
      {
        id: "client-row-1",
        client_id: "claude-code",
        name: "Claude Code",
        redirect_uris: ["https://agent.example.com/oauth/callback"],
        disabled_at: null,
      },
    ];
    this.authCodes = [];
    this.tokens = [];
    this.seq = 0;
  }

  async query(sql, params = []) {
    const text = sql.replace(/\s+/g, " ").trim();

    if (text.startsWith("SELECT id, client_id, name, redirect_uris, disabled_at FROM mcp_clients")) {
      const [clientId] = params;
      const client = this.clients.find((c) => c.client_id === clientId);
      return { rowCount: client ? 1 : 0, rows: client ? [client] : [] };
    }

    if (text.includes("FROM customer_workspace_memberships cwm") && text.includes("JOIN workspaces w")) {
      const [customerId, workspaceId] = params;
      const authorized = this.memberships.some((m) => m.customerId === customerId && m.workspaceId === workspaceId);
      const workspace = authorized ? this.workspaces.find((w) => w.id === workspaceId) : null;
      return { rowCount: workspace ? 1 : 0, rows: workspace ? [workspace] : [] };
    }

    if (text.startsWith("INSERT INTO mcp_authorization_codes")) {
      const [codeHash, clientRowId, customerId, workspaceId, redirectUri, codeChallenge, codeChallengeMethod, expiresAt] = params;
      this.authCodes.push({
        id: `code-${this.seq++}`,
        code_hash: codeHash,
        mcp_client_id: clientRowId,
        customer_identity_id: customerId,
        workspace_id: workspaceId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        expires_at: expiresAt,
        used_at: null,
      });
      return { rowCount: 1, rows: [] };
    }

    if (text.startsWith("UPDATE mcp_authorization_codes")) {
      const [codeHash, clientRowId] = params;
      const now = Date.now();
      const record = this.authCodes.find(
        (c) => c.code_hash === codeHash && c.mcp_client_id === clientRowId && !c.used_at && new Date(c.expires_at).getTime() > now,
      );
      if (!record) return { rowCount: 0, rows: [] };
      record.used_at = new Date().toISOString();
      return {
        rowCount: 1,
        rows: [
          {
            id: record.id,
            customer_identity_id: record.customer_identity_id,
            workspace_id: record.workspace_id,
            redirect_uri: record.redirect_uri,
            code_challenge: record.code_challenge,
            code_challenge_method: record.code_challenge_method,
          },
        ],
      };
    }

    if (text.startsWith("INSERT INTO mcp_tokens")) {
      const [tokenFamilyId, clientRowId, customerId, workspaceId, accessTokenHash, accessExpiresAt, refreshTokenHash, refreshExpiresAt] = params;
      this.tokens.push({
        id: `token-${this.seq++}`,
        token_family_id: tokenFamilyId,
        mcp_client_id: clientRowId,
        customer_identity_id: customerId,
        workspace_id: workspaceId,
        access_token_hash: accessTokenHash,
        access_token_expires_at: accessExpiresAt,
        refresh_token_hash: refreshTokenHash,
        refresh_token_expires_at: refreshExpiresAt,
        rotated_at: null,
        revoked_at: null,
      });
      return { rowCount: 1, rows: [] };
    }

    if (text.startsWith("SELECT customer_identity_id, workspace_id, mcp_client_id, access_token_expires_at, revoked_at")) {
      const [accessTokenHash] = params;
      const row = this.tokens.find((t) => t.access_token_hash === accessTokenHash);
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }

    if (text === "SELECT id FROM mcp_clients WHERE client_id=$1 AND disabled_at IS NULL") {
      const [clientId] = params;
      const client = this.clients.find((c) => c.client_id === clientId && !c.disabled_at);
      return { rowCount: client ? 1 : 0, rows: client ? [{ id: client.id }] : [] };
    }

    if (text.startsWith("SELECT id, token_family_id, customer_identity_id, workspace_id, mcp_client_id, refresh_token_expires_at, rotated_at, revoked_at")) {
      const [refreshTokenHash] = params;
      const row = this.tokens.find((t) => t.refresh_token_hash === refreshTokenHash);
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }

    if (text === "UPDATE mcp_tokens SET revoked_at = now() WHERE token_family_id = $1 AND revoked_at IS NULL") {
      const [tokenFamilyId] = params;
      let count = 0;
      for (const t of this.tokens) {
        if (t.token_family_id === tokenFamilyId && !t.revoked_at) {
          t.revoked_at = new Date().toISOString();
          count += 1;
        }
      }
      return { rowCount: count, rows: [] };
    }

    if (text === "UPDATE mcp_tokens SET rotated_at = now() WHERE id = $1") {
      const [id] = params;
      const row = this.tokens.find((t) => t.id === id);
      if (row) row.rotated_at = new Date().toISOString();
      return { rowCount: row ? 1 : 0, rows: [] };
    }

    if (text.startsWith("UPDATE mcp_tokens SET revoked_at = now() WHERE token_family_id = $1 AND customer_identity_id = $2")) {
      const [tokenFamilyId, customerId, workspaceId] = params;
      let count = 0;
      for (const t of this.tokens) {
        if (t.token_family_id === tokenFamilyId && t.customer_identity_id === customerId && t.workspace_id === workspaceId && !t.revoked_at) {
          t.revoked_at = new Date().toISOString();
          count += 1;
        }
      }
      return { rowCount: count, rows: [] };
    }

    throw new Error(`Unhandled fake query: ${text}`);
  }
}

const REDIRECT_URI = "https://agent.example.com/oauth/callback";

test("createAuthorizationCode reuses the real tenant-boundary check — refuses a workspace the customer does not belong to", async () => {
  const db = new FakeDb();
  const { challenge } = realPkcePair();
  await assert.rejects(
    createAuthorizationCode(db, {
      customerId: "identity-a",
      workspaceId: "workspace-belonging-to-someone-else",
      clientId: "claude-code",
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
    }),
    (error) => error.code === "WORKSPACE_NOT_FOUND",
  );
});

test("createAuthorizationCode refuses an unknown client", async () => {
  const db = new FakeDb();
  const { challenge } = realPkcePair();
  await assert.rejects(
    createAuthorizationCode(db, {
      customerId: "identity-a",
      workspaceId: "workspace-a",
      clientId: "not-a-registered-client",
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
    }),
    (error) => error instanceof McpAuthError && error.code === "INVALID_CLIENT",
  );
});

test("createAuthorizationCode refuses a redirect_uri not on the client's exact allowlist", async () => {
  const db = new FakeDb();
  const { challenge } = realPkcePair();
  await assert.rejects(
    createAuthorizationCode(db, {
      customerId: "identity-a",
      workspaceId: "workspace-a",
      clientId: "claude-code",
      redirectUri: "https://attacker.com/oauth/callback",
      codeChallenge: challenge,
    }),
    (error) => error.code === "INVALID_REDIRECT_URI",
  );
});

test("full authorization-code + PKCE exchange succeeds end to end for a legitimate grant", async () => {
  const db = new FakeDb();
  const { verifier, challenge } = realPkcePair();
  const { code } = await createAuthorizationCode(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    clientId: "claude-code",
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
  });

  const tokens = await exchangeAuthorizationCode(db, {
    code,
    clientId: "claude-code",
    redirectUri: REDIRECT_URI,
    codeVerifier: verifier,
  });

  assert.equal(tokens.tokenType, "Bearer");
  assert.ok(tokens.accessToken);
  assert.ok(tokens.refreshToken);

  const resolved = await verifyAccessToken(db, { accessToken: tokens.accessToken });
  assert.equal(resolved.customerId, "identity-a");
  assert.equal(resolved.workspaceId, "workspace-a");
});

test("exchangeAuthorizationCode rejects the wrong PKCE verifier", async () => {
  const db = new FakeDb();
  const { challenge } = realPkcePair();
  const { code } = await createAuthorizationCode(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    clientId: "claude-code",
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
  });

  await assert.rejects(
    exchangeAuthorizationCode(db, {
      code,
      clientId: "claude-code",
      redirectUri: REDIRECT_URI,
      codeVerifier: randomBytes(32).toString("base64url"),
    }),
    (error) => error.code === "INVALID_GRANT",
  );
});

test("an authorization code can only ever be exchanged once", async () => {
  const db = new FakeDb();
  const { verifier, challenge } = realPkcePair();
  const { code } = await createAuthorizationCode(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    clientId: "claude-code",
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
  });

  await exchangeAuthorizationCode(db, { code, clientId: "claude-code", redirectUri: REDIRECT_URI, codeVerifier: verifier });
  await assert.rejects(
    exchangeAuthorizationCode(db, { code, clientId: "claude-code", redirectUri: REDIRECT_URI, codeVerifier: verifier }),
    (error) => error.code === "INVALID_GRANT",
  );
});

test("exchangeAuthorizationCode rejects a redirect_uri that does not match the authorization request, even if it's on the allowlist", async () => {
  const db = new FakeDb();
  db.clients[0].redirect_uris.push("https://agent.example.com/oauth/other-callback");
  const { verifier, challenge } = realPkcePair();
  const { code } = await createAuthorizationCode(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    clientId: "claude-code",
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
  });

  await assert.rejects(
    exchangeAuthorizationCode(db, {
      code,
      clientId: "claude-code",
      redirectUri: "https://agent.example.com/oauth/other-callback",
      codeVerifier: verifier,
    }),
    (error) => error.code === "INVALID_GRANT",
  );
});

test("an expired authorization code is rejected even with a correct verifier", async () => {
  const db = new FakeDb();
  const { verifier, challenge } = realPkcePair();
  const { code } = await createAuthorizationCode(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    clientId: "claude-code",
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
  });
  db.authCodes[0].expires_at = new Date(Date.now() - 1000).toISOString();

  await assert.rejects(
    exchangeAuthorizationCode(db, { code, clientId: "claude-code", redirectUri: REDIRECT_URI, codeVerifier: verifier }),
    (error) => error.code === "INVALID_GRANT",
  );
});

test("verifyAccessToken rejects a garbage token, a revoked token, and an expired token", async () => {
  const db = new FakeDb();
  const { verifier, challenge } = realPkcePair();
  const { code } = await createAuthorizationCode(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    clientId: "claude-code",
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
  });
  const tokens = await exchangeAuthorizationCode(db, { code, clientId: "claude-code", redirectUri: REDIRECT_URI, codeVerifier: verifier });

  await assert.rejects(verifyAccessToken(db, { accessToken: "not-a-real-token" }), (e) => e.code === "INVALID_TOKEN");

  db.tokens[0].revoked_at = new Date().toISOString();
  await assert.rejects(verifyAccessToken(db, { accessToken: tokens.accessToken }), (e) => e.code === "INVALID_TOKEN");

  db.tokens[0].revoked_at = null;
  db.tokens[0].access_token_expires_at = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(verifyAccessToken(db, { accessToken: tokens.accessToken }), (e) => e.code === "INVALID_TOKEN");
});

test("refresh token rotation issues a new pair and invalidates the old refresh token", async () => {
  const db = new FakeDb();
  const { verifier, challenge } = realPkcePair();
  const { code } = await createAuthorizationCode(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    clientId: "claude-code",
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
  });
  const original = await exchangeAuthorizationCode(db, { code, clientId: "claude-code", redirectUri: REDIRECT_URI, codeVerifier: verifier });

  const rotated = await rotateRefreshToken(db, { refreshToken: original.refreshToken, clientId: "claude-code" });
  assert.notEqual(rotated.accessToken, original.accessToken);
  assert.notEqual(rotated.refreshToken, original.refreshToken);

  const resolved = await verifyAccessToken(db, { accessToken: rotated.accessToken });
  assert.equal(resolved.workspaceId, "workspace-a");
});

test("reusing an already-rotated refresh token revokes the ENTIRE token family, including the still-valid access token", async () => {
  const db = new FakeDb();
  const { verifier, challenge } = realPkcePair();
  const { code } = await createAuthorizationCode(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    clientId: "claude-code",
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
  });
  const original = await exchangeAuthorizationCode(db, { code, clientId: "claude-code", redirectUri: REDIRECT_URI, codeVerifier: verifier });
  await rotateRefreshToken(db, { refreshToken: original.refreshToken, clientId: "claude-code" });

  // The original refresh token has now been rotated once — presenting it
  // again is exactly the theft-reuse scenario.
  await assert.rejects(
    rotateRefreshToken(db, { refreshToken: original.refreshToken, clientId: "claude-code" }),
    (error) => error.code === "REUSE_DETECTED",
  );

  // The consequence must reach beyond the refresh token itself: the
  // original access token, issued in the same family, must also now be
  // dead — otherwise reuse detection is security theater.
  await assert.rejects(verifyAccessToken(db, { accessToken: original.accessToken }), (e) => e.code === "INVALID_TOKEN");
});

test("revokeTokenFamily is tenant-scoped — cannot revoke a family belonging to a different customer or workspace", async () => {
  const db = new FakeDb();
  const { verifier, challenge } = realPkcePair();
  const { code } = await createAuthorizationCode(db, {
    customerId: "identity-a",
    workspaceId: "workspace-a",
    clientId: "claude-code",
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
  });
  const tokens = await exchangeAuthorizationCode(db, { code, clientId: "claude-code", redirectUri: REDIRECT_URI, codeVerifier: verifier });
  const tokenFamilyId = db.tokens[0].token_family_id;

  const wrongCustomer = await revokeTokenFamily(db, { customerId: "identity-b", workspaceId: "workspace-a", tokenFamilyId });
  assert.equal(wrongCustomer.revokedCount, 0);
  const wrongWorkspace = await revokeTokenFamily(db, { customerId: "identity-a", workspaceId: "workspace-b", tokenFamilyId });
  assert.equal(wrongWorkspace.revokedCount, 0);

  // Confirm the token is still alive after both failed cross-tenant attempts.
  const stillValid = await verifyAccessToken(db, { accessToken: tokens.accessToken });
  assert.equal(stillValid.workspaceId, "workspace-a");

  const correct = await revokeTokenFamily(db, { customerId: "identity-a", workspaceId: "workspace-a", tokenFamilyId });
  assert.equal(correct.revokedCount, 1);
  await assert.rejects(verifyAccessToken(db, { accessToken: tokens.accessToken }), (e) => e.code === "INVALID_TOKEN");
});
