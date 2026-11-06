import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { exchangeGoogleCode, fetchGoogleUser, googleRedirectUri } from "@/src/server/google-oauth.mjs";
import { clearCookieOptions, oauthStateCookieName } from "@/src/server/session.mjs";
import { completeSignIn } from "@/src/server/sign-in.mjs";

export const dynamic = "force-dynamic";

const verifierCookieName = "utplava_google_pkce";

export async function GET(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const store = await cookies();
  const expectedState = store.get(oauthStateCookieName)?.value;
  const verifier = store.get(verifierCookieName)?.value;
  store.set(verifierCookieName, "", clearCookieOptions());

  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    return Response.redirect(new URL("/?auth=failed", request.url));
  }

  let db;
  try {
    const accessToken = await exchangeGoogleCode({ code, redirectUri: googleRedirectUri(request), codeVerifier: verifier });
    const identity = await fetchGoogleUser({ accessToken });
    db = await connectDatabase();
    const next = await completeSignIn(db, { store, request, identity });
    return Response.redirect(next);
  } catch {
    return Response.redirect(new URL("/?auth=failed", request.url));
  } finally {
    if (db) await db.end();
  }
}
