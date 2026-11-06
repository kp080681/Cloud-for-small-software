// Sign in with Google (2026-11-06). Uploads no longer need GitHub, and many
// people (ChatGPT users especially) have Google but not GitHub. Scopes are
// the minimum: openid, email, profile. Utplava never sees a Google password
// and gets no access to Gmail, Drive or anything else.
//
// Identity: provider "google", keyed by Google's stable subject id (never by
// email, which can change). Only verified Google emails are accepted.

import { createHash, randomBytes } from "node:crypto";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export function googleRedirectUri(request) {
  return new URL("/api/auth/google/callback", request.url).toString();
}

export function googleOAuthConfig(env = process.env) {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error("Google sign-in is not configured."), { code: "GOOGLE_OAUTH_NOT_CONFIGURED" });
  }
  return { clientId, clientSecret };
}

export function isGoogleSignInConfigured(env = process.env) {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function createPkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function googleAuthorizationUrl({ state, redirectUri, codeChallenge, env = process.env }) {
  const { clientId } = googleOAuthConfig(env);
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url;
}

export async function exchangeGoogleCode({ code, redirectUri, codeVerifier, env = process.env, fetchImpl = fetch }) {
  const { clientId, clientSecret } = googleOAuthConfig(env);
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    throw Object.assign(new Error("Google token exchange failed."), { code: "GOOGLE_OAUTH_TOKEN_FAILED" });
  }
  const body = await response.json();
  if (!body?.access_token) {
    throw Object.assign(new Error("Google token exchange returned no token."), { code: "GOOGLE_OAUTH_TOKEN_MISSING" });
  }
  return body.access_token;
}

export function normalizeGoogleUser(user) {
  const sub = typeof user?.sub === "string" ? user.sub : null;
  const email = typeof user?.email === "string" ? user.email.toLowerCase() : null;
  if (!sub || !/^[0-9]{5,40}$/.test(sub) || !email) {
    throw Object.assign(new Error("Google profile was incomplete."), { code: "GOOGLE_USER_INCOMPLETE" });
  }
  if (user.email_verified !== true && user.email_verified !== "true") {
    throw Object.assign(new Error("Google email is not verified."), { code: "GOOGLE_EMAIL_UNVERIFIED" });
  }
  const name = typeof user.name === "string" && user.name.trim() ? user.name.trim().slice(0, 100) : email.split("@")[0];
  const picture = typeof user.picture === "string" && user.picture.startsWith("https://") ? user.picture : null;
  return {
    provider: "google",
    providerAccountId: sub,
    login: email,
    displayName: name,
    avatarUrl: picture,
  };
}

export async function fetchGoogleUser({ accessToken, fetchImpl = fetch }) {
  const response = await fetchImpl(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw Object.assign(new Error("Google profile request failed."), { code: "GOOGLE_USER_FAILED" });
  }
  return normalizeGoogleUser(await response.json());
}
