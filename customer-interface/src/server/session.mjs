import Iron from "@hapi/iron";

export const sessionCookieName = "utplava_session";
export const oauthStateCookieName = "utplava_oauth_state";
export const selectedWorkspaceCookieName = "utplava_workspace";

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
    Iron.defaults,
  );
}

export async function unsealSession(value, secret = requireSessionSecret()) {
  if (!value) return null;
  try {
    const session = await Iron.unseal(value, secret, Iron.defaults);
    if (!session?.customerId || !session?.provider || !session?.login) return null;
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
