-- 033: Confidential MCP clients (2026-11-07).
-- Some platforms (Superhuman/Coda Packs) register with dynamic client
-- registration and expect a client secret, and may not send PKCE. Such a
-- client gets a secret at registration (stored only as a SHA-256 hash) and
-- must present it on every token request. Only those clients may skip PKCE;
-- public clients (Claude, ChatGPT, Grok, editors) still must use PKCE S256.

BEGIN;

ALTER TABLE mcp_clients
  ADD COLUMN IF NOT EXISTS client_secret_hash text,
  ADD COLUMN IF NOT EXISTS token_endpoint_auth_method text NOT NULL DEFAULT 'none';

DO $$ BEGIN
  ALTER TABLE mcp_clients ADD CONSTRAINT mcp_clients_auth_method_check
    CHECK (
      (token_endpoint_auth_method = 'none' AND client_secret_hash IS NULL)
      OR (token_endpoint_auth_method IN ('client_secret_post', 'client_secret_basic') AND client_secret_hash IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A code issued without PKCE has neither column set.
ALTER TABLE mcp_authorization_codes
  ALTER COLUMN code_challenge DROP NOT NULL,
  ALTER COLUMN code_challenge_method DROP NOT NULL,
  ALTER COLUMN code_challenge_method DROP DEFAULT;

DO $$ BEGIN
  ALTER TABLE mcp_authorization_codes ADD CONSTRAINT mcp_authorization_codes_pkce_pair_check
    CHECK ((code_challenge IS NULL) = (code_challenge_method IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
