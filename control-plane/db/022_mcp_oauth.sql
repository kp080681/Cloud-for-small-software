BEGIN;

-- Statically-registered MCP clients (AI platforms allowed to request tokens).
-- Deliberately NOT dynamic client registration (RFC 7591) — Utplava controls
-- which platforms can onboard for now; a client row is added by an operator,
-- not self-registered by an arbitrary caller. redirect_uris is an exact-match
-- allowlist, not a pattern — the single most important anti-open-redirect
-- control in this whole flow, so it does not get to be "close enough".
CREATE TABLE mcp_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL UNIQUE,
  name text NOT NULL,
  redirect_uris text[] NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Single-use, short-lived authorization codes. Binds the code to exactly the
-- workspace the authenticated customer chose (via getAuthorizedWorkspace at
-- issuance — see mcp-auth.mjs) and to the PKCE challenge and redirect_uri
-- presented at authorization time, so the token endpoint can re-verify both
-- rather than trusting the client's second request blindly.
CREATE TABLE mcp_authorization_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  mcp_client_id uuid NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  customer_identity_id uuid NOT NULL REFERENCES customer_identities(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Access/refresh token pairs, stored as hashes only — same principle as
-- password/secret storage: nothing here needs to be reversible, so nothing
-- here should be reversible, not even by Utplava's own operators.
--
-- token_family_id ties every refresh generation of the same original grant
-- together. On refresh, the old row is marked rotated_at and a new row is
-- inserted in the same family; presenting an already-rotated refresh token
-- again is treated as a signal of token theft and revokes the whole family
-- (see rotateRefreshToken in mcp-auth.mjs), not just the one token.
CREATE TABLE mcp_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_family_id uuid NOT NULL,
  mcp_client_id uuid NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  customer_identity_id uuid NOT NULL REFERENCES customer_identities(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  access_token_hash text NOT NULL UNIQUE,
  access_token_expires_at timestamptz NOT NULL,
  refresh_token_hash text UNIQUE,
  refresh_token_expires_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mcp_tokens_family_idx ON mcp_tokens (token_family_id);
CREATE INDEX mcp_tokens_workspace_idx ON mcp_tokens (workspace_id);
CREATE INDEX mcp_authorization_codes_workspace_idx ON mcp_authorization_codes (workspace_id);

COMMIT;
