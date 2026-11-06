-- 032: Password logins for accounts Utplava creates (2026-11-06).
-- Only for app-directory reviewers (OpenAI, Anthropic) and test accounts:
-- review rules forbid logins that need two-step checks or a fresh sign-up.
-- There is no public sign-up with a password. Rows are created by the owner
-- with customer-interface/scripts/password-login-sql.mjs; the password is
-- stored only as a scrypt hash.

BEGIN;

CREATE TABLE IF NOT EXISTS password_logins (
  customer_identity_id uuid PRIMARY KEY REFERENCES customer_identities(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
