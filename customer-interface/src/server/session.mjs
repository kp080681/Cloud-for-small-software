import Iron from "@hapi/iron";

export const sessionCookieName = "utplava_session";
export const oauthStateCookieName = "utplava_oauth_state";
export const selectedWorkspaceCookieName = "utplava_workspace";

// Matches sessionCookieOptions' own maxAge below — the sealed payload and
// the cookie carrying it should always expire together. An independent
// review (Opus 5.5) found that Iron.defaults has ttl: 0 (no expiry) and
// that the issuedAt field this module already wrote into every session
// was never actually checked on unseal — meaning a stolen session cookie
// (malware, a shared machine, a leaked HAR file) stayed valid forever,
// until UTPLAVA_SESSION_SECRET was rotated for every user at once. This
// is a real fix, not a complete one: it makes a stolen session expire
// within a week instead of never, but there is still no way to revoke one
// specific customer's sessions on demand — that needs a server-side
// session_version checked against a DB on every request, a bigger design
// addition than this pass, and not done here.
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function requireSessionSecret(env = process.env) {
  const secret = env.UTPLAVA_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw Object.assign(new Error("UTPLAVA_SESSION_SECRET must be at least 32 characters."), {
      code: "SESSION_SECRET_REQUIRED",
    });
  }
  return secret;
}

export function sessionCookieOptions(env = process.env) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}

export function stateCookieOptions(env = process.env) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60,
  };
}

export function clearCookieOptions() {
  return {
    path: "/",
    maxAge: 0,
  };
}

export async function sealSession(session, secret = requireSessionSecret()) {
  return Iron.seal(
    {
      customerId: session.customerId,
      provider: session.provider,
      login: session.login,
      name: session.name ?? null,
      avatarUrl: session.avatarUrl ?? null,
      issuedAt: Date.now(),
    },
    secret,
    { ...Iron.defaults, ttl: SESSION_TTL_MS },
  );
}

export async function unsealSession(value, secret = requireSessionSecret(), now = Date.now()) {
  if (!value) return null;
  try {
    const session = await Iron.unseal(value, secret, { ...Iron.defaults, ttl: SESSION_TTL_MS });
    if (!session?.customerId || !session?.provider || !session?.login) return null;
    // Defense in depth alongside Iron's own ttl enforcement just above:
    // an explicit staleness check against the issuedAt this module
    // controls, rather than relying solely on Iron's internal timestamp
    // handling (which by default also tolerates ~60s of clock skew).
    if (typeof session.issuedAt !== "number" || now - session.issuedAt > SESSION_TTL_MS) return null;
    return {
      customerId: session.customerId,
      provider: session.provider,
      login: session.login,
      name: session.name ?? session.login,
      avatarUrl: session.avatarUrl ?? null,
    };
  } catch {
    return null;
  }
}

export function publicSession(session) {
  return {
    authenticated: true,
    user: {
      id: session.customerId,
      provider: session.provider,
      login: session.login,
      name: session.name ?? session.login,
      avatarUrl: session.avatarUrl ?? null,
    },
  };
}

export function assertAuthenticatedSession(session) {
  if (!session?.customerId) {
    throw Object.assign(new Error("Authentication required."), {
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
  }
  return session;
}
