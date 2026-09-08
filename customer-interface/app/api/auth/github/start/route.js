import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createOAuthState,
  githubAuthorizationUrl,
  githubRedirectUri,
} from "@/src/server/github-oauth.mjs";
import { oauthStateCookieName, stateCookieOptions } from "@/src/server/session.mjs";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const state = createOAuthState();
  const redirectUri = githubRedirectUri(request);
  const store = await cookies();
  store.set(oauthStateCookieName, state, stateCookieOptions());
  redirect(githubAuthorizationUrl({ state, redirectUri }).toString());
}
