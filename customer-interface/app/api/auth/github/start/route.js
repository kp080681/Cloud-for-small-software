import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createOAuthState,
  githubAuthorizationUrl,
  githubRedirectUri,
} from "@/src/server/github-oauth.mjs";
import { oauthStateCookieName, returnToCookieName, stateCookieOptions } from "@/src/server/session.mjs";
import { safeReturnTo } from "@/src/server/mcp-registration.mjs";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const state = createOAuthState();
  const redirectUri = githubRedirectUri(request);
  const store = await cookies();
  store.set(oauthStateCookieName, state, stateCookieOptions());
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return_to"));
  if (returnTo) store.set(returnToCookieName, returnTo, stateCookieOptions());
  redirect(githubAuthorizationUrl({ state, redirectUri }).toString());
}
