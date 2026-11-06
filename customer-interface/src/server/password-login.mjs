// Email-and-password sign-in, ONLY for accounts Utplava created (directory
// reviewers, test accounts). No public sign-up, no password reset: the owner
// creates and replaces these with scripts/password-login-sql.mjs.
//
// - scrypt (N=2^15) with a per-account salt; compared in constant time
// - unknown emails still pay for a hash, so timing doesn't reveal accounts
// - 10 wrong passwords lock the account for 10 minutes

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;
export const MAX_FAILED = 10;
export const LOCK_MINUTES = 10;

export async function hashPassword(password, salt = randomBytes(16)) {
  const key = await scrypt(String(password).normalize("NFKC"), salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64url")}$${Buffer.from(key).toString("base64url")}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltText, keyText] = parts;
  const expected = Buffer.from(keyText, "base64url");
  const key = await scrypt(String(password).normalize("NFKC"), Buffer.from(saltText, "base64url"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return expected.length === key.length && timingSafeEqual(expected, Buffer.from(key));
}

const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export class PasswordLoginError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PasswordLoginError";
    this.code = code;
  }
}

// Returns the customer_identities row on success; throws PasswordLoginError.
export async function checkPasswordLogin(db, { email, password }) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !password || normalized.length > 200 || String(password).length > 200) {
    throw new PasswordLoginError("PASSWORD_LOGIN_FAILED", "That email and password don't match an account.");
  }
  const found = await db.query(
    `SELECT pl.customer_identity_id, pl.password_hash, pl.failed_attempts, pl.locked_until,
            ci.id, ci.provider, ci.provider_account_id, ci.login, ci.display_name, ci.avatar_url
       FROM password_logins pl
       JOIN customer_identities ci ON ci.id = pl.customer_identity_id
      WHERE pl.email = $1`,
    [normalized],
  );
  const row = found.rows[0];
  if (!row) {
    await verifyPassword(password, DUMMY_HASH).catch(() => false);
    throw new PasswordLoginError("PASSWORD_LOGIN_FAILED", "That email and password don't match an account.");
  }
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    throw new PasswordLoginError("PASSWORD_LOGIN_LOCKED", "Too many wrong tries. Wait 10 minutes and try again.");
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    await db.query(
      `UPDATE password_logins
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
        WHERE customer_identity_id = $1`,
      [row.customer_identity_id, MAX_FAILED, String(LOCK_MINUTES)],
    );
    throw new PasswordLoginError("PASSWORD_LOGIN_FAILED", "That email and password don't match an account.");
  }
  await db.query(
    `UPDATE password_logins SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE customer_identity_id = $1`,
    [row.customer_identity_id],
  );
  return {
    id: row.id,
    provider: row.provider,
    provider_account_id: row.provider_account_id,
    login: row.login,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
  };
}
