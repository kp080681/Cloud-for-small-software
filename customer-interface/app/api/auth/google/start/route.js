import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createOAuthState } from "@/src/server/github-oauth.mjs";
import { createPkcePair, googleAuthorizationUrl, googleRedirectUri, isGoogleSignInConfigured } from "@/src/server/google-oauth.mjs";
import { oauthStateCookieName, returnToCookieName, stateCookieOptions } from "@/src/server/session.mjs";
import { safeReturnTo } from "@/src/server/mcp-registration.mjs";
import { countMcpSignIn } from "@/src/server/mcp-signin-count.mjs";

export const dynamic = "force-dynamic";

const verifierCookieName = "utplava_google_pkce";

export async function GET(request) {
  if (!isGoogleSignInConfigured()) return Response.redirect(new URL("/?auth=unavailable", request.url));
  const state = createOAuthState();
  const { verifier, challenge } = createPkcePair();
  const store = await cookies();
  store.set(oauthStateCookieName, state, stateCookieOptions());
  store.set(verifierCookieName, verifier, stateCookieOptions());
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return_to"));
  if (returnTo) store.set(returnToCookieName, returnTo, stateCookieOptions());
  await countMcpSignIn(returnTo);
  redirect(googleAuthorizationUrl({ state, redirectUri: googleRedirectUri(request), codeChallenge: challenge }).toString());
}
