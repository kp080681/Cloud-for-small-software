import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
  McpAuthError,
  createAuthorizationCode,
  enforceMcpToolCallLimit,
  exchangeAuthorizationCode,
  listTokenFamilies,
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

    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SELECT pg_advisory_xact_lock")) {
      return { rowCount: 0, rows: [] };
    }

    if (text === "SELECT token_family_id FROM mcp_tokens WHERE refresh_token_hash=$1") {
      const [refreshTokenHash] = params;
      const row = this.tokens.find((t) => t.refresh_token_hash === refreshTokenHash);
      return { rowCount: row ? 1 : 0, rows: row ? [{ token_family_id: row.token_family_id }] : [] };
    }

    if (text.startsWith("SELECT id, token_family_id, customer_identity_id, workspace_id, mcp_client_id, refresh_token_expires_at, rotated_at, revoked_at")) {
      const [refreshTokenHash] = params;
      const row = this.tokens.find((t) => t.refresh_token_hash === refreshTokenHash);
      const familyCreatedAt = row ? (this.familyCreatedAt?.get(row.token_family_id) ?? new Date().toISOString()) : null;
      return { rowCount: row ? 1 : 0, rows: row ? [{ ...row, family_created_at: familyCreatedAt }] : [] };
    }

    if (text === "UPDATE mcp_tokens SET rotated_at = now() WHERE id = $1") {
      const [id] = params;
      const row = this.tokens.find((t) => t.id === id);
      if (row) row.rotated_at = new Date().toISOString();
      return { rowCount: row ? 1 : 0, rows: [] };
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

    if (text.startsWith("INSERT INTO workspace_rate_limit_counters")) {
      const [workspaceId, action, windowStart] = params;
      this.rateLimitCounters ??= new Map();
      const key = `${workspaceId}:${action}:${windowStart}`;
      const next = (this.rateLimitCounters.get(key) ?? 0) + 1;
      this.rateLimitCounters.set(key, next);
      return { rowCount: 1, rows: [{ count: next }] };
    }

    if (text.startsWith("SELECT t.token_family_id, c.name AS client_name")) {
      const [workspaceId, customerId] = params;
      const families = new Map();
      for (const t of this.tokens) {
        if (t.workspace_id !== workspaceId || t.customer_identity_id !== customerId) continue;
        const client = this.clients.find((c) => c.id === t.mcp_client_id);
        const existing = families.get(t.token_family_id) ?? {
          token_family_id: t.token_family_id,
          client_name: client?.name ?? null,
          authorized_at: t.created_at,
          last_refreshed_at: t.created_at,
          revoked: true,
        };
        existing.authorized_at = new Date(t.created_at) < new Date(existing.authorized_at) ? t.created_at : existing.authorized_at;
        existing.last_refreshed_at = new Date(t.created_at) > new Date(existing.last_refreshed_at) ? t.created_at : existing.last_refreshed_at;
        existing.revoked = existing.revoked && Boolean(t.revoked_at);
        families.set(t.token_family_id, existing);
      }
      const rows = [...families.values()].sort((a, b) => new Date(b.last_refreshed_at) - new Date(a.last_refreshed_at));
      return { rowCount: rows.length, rows };
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

// The two tests that used to live here (aggregate 60/hour MCP call
// budget, and confirming it's per-workspace) were removed after an
// independent review (Opus 5.5) found that enforcing this limit inside
// verifyAccessToken meant a rate-limited caller was told "invalid token"
// instead of "slow down," and that every protocol message — not just real
// tool calls — counted against the budget. The check moved to the MCP
// route's own tool-dispatch wrapper (runTool in app/api/mcp/route.js),
// which node:test can't import directly (it uses the @/ path alias, same
// as every other route.js file in this codebase) — verified instead via
// `next build`, the established verification method for route wiring
// throughout this project. The underlying rate-limit mechanics themselves
// are already thoroughly tested in rate-limit.test.mjs.

test("enforceMcpToolCallLimit enforces an aggregate 60/hour MCP tool-call budget per workspace — extracted into mcp-auth.mjs specifically so this logic keeps real node:test coverage, since route.js (where it's actually called from) can't be imported by node:test at all due to its @/ path alias", async () => {
  const db = new FakeDb();
  for (let i = 0; i < 60; i += 1) await enforceMcpToolCallLimit(db, { workspaceId: "workspace-a" });
  await assert.rejects(
    enforceMcpToolCallLimit(db, { workspaceId: "workspace-a" }),
    (error) => error.code === "WORKSPACE_RATE_LIMIT_REACHED",
  );
});

test("enforceMcpToolCallLimit's budget is per workspace, not global", async () => {
  const db = new FakeDb();
  for (let i = 0; i < 60; i += 1) await enforceMcpToolCallLimit(db, { workspaceId: "workspace-a" });
  await assert.rejects(enforceMcpToolCallLimit(db, { workspaceId: "workspace-a" }), (e) => e.code === "WORKSPACE_RATE_LIMIT_REACHED");
  const decision = await enforceMcpToolCallLimit(db, { workspaceId: "workspace-b" });
  assert.equal(decision.allowed, true);
});

test("a token family past its 90-day absolute maximum age cannot be refreshed, and the whole family is revoked — regression test for a gap a second independent-review pass (Opus 5.5) found: REFRESH_TOKEN_TTL_SECONDS only bounds a single token, so a grant that keeps refreshing itself never actually expires without a separate cap on the family's total age", async () => {
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
  db.familyCreatedAt = new Map([[db.tokens[0].token_family_id, new Date(Date.now() - 91 * 24 * 3600 * 1000).toISOString()]]);

  await assert.rejects(
    rotateRefreshToken(db, { refreshToken: tokens.refreshToken, clientId: "claude-code" }),
    (error) => error instanceof McpAuthError && error.code === "INVALID_GRANT",
  );
  assert.ok(db.tokens.every((t) => t.revoked_at), "the whole family must be revoked, not just this one rotation rejected");
});

test("a token family well within its 90-day lifetime can still be refreshed normally — regression guard so the max-age check above doesn't accidentally reject fresh grants", async () => {
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
  db.familyCreatedAt = new Map([[db.tokens[0].token_family_id, new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString()]]);

  const rotated = await rotateRefreshToken(db, { refreshToken: tokens.refreshToken, clientId: "claude-code" });
  assert.ok(rotated.accessToken);
});

test("listTokenFamilies lists a workspace's grants with the tokenFamilyId revokeTokenFamily needs, tenant-scoped the same way every other lookup here is", async () => {
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

  const grants = await listTokenFamilies(db, { customerId: "identity-a", workspaceId: "workspace-a" });
  assert.equal(grants.length, 1);
  assert.equal(grants[0].tokenFamilyId, db.tokens[0].token_family_id);
  assert.equal(grants[0].clientName, "Claude Code");
  assert.equal(grants[0].revoked, false);

  await assert.rejects(
    listTokenFamilies(db, { customerId: "identity-b", workspaceId: "workspace-a" }),
    (error) => error.code === "WORKSPACE_NOT_FOUND",
  );
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
