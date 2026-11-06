#!/usr/bin/env node
// Creates (or replaces the password of) a reviewer/test login.
// Usage: node scripts/password-login-sql.mjs reviewer@utplava.dev "OpenAI reviewer"
// Prints a new random password ONCE and the SQL to run in Neon. The SQL
// holds only the scrypt hash. Keep the password in a password manager and
// give it only to the reviewer, through the review form.
import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/server/password-login.mjs";

const email = String(process.argv[2] || "").trim().toLowerCase();
const name = String(process.argv[3] || "Reviewer").trim().slice(0, 80);
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("Usage: node scripts/password-login-sql.mjs <email> [display name]");
  process.exit(1);
}
const password = randomBytes(18).toString("base64url");
const hash = await hashPassword(password);
const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
console.log(`\nPassword (shown once): ${password}\n`);
console.log(`-- Run in Neon:
BEGIN;
WITH ci AS (
  INSERT INTO customer_identities (provider, provider_account_id, login, display_name)
  VALUES ('password', ${q(email)}, ${q(email)}, ${q(name)})
  ON CONFLICT (provider, provider_account_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
  RETURNING id
)
INSERT INTO password_logins (customer_identity_id, email, password_hash)
SELECT id, ${q(email)}, ${q(hash)} FROM ci
ON CONFLICT (customer_identity_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_attempts = 0, locked_until = NULL;
COMMIT;
`);
