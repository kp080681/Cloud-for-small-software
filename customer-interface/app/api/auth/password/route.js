import { cookies } from "next/headers";
import { connectDatabase } from "@/src/server/db.mjs";
import { checkPasswordLogin } from "@/src/server/password-login.mjs";
import { returnToCookieName, stateCookieOptions } from "@/src/server/session.mjs";
import { safeReturnTo } from "@/src/server/mcp-registration.mjs";
import { completeSignIn } from "@/src/server/sign-in.mjs";
import { countMcpSignIn } from "@/src/server/mcp-signin-count.mjs";

export const dynamic = "force-dynamic";

function back(request, code, returnTo) {
  const url = new URL("/sign-in/email", request.url);
  url.searchParams.set("error", code);
  if (returnTo) url.searchParams.set("return_to", returnTo);
  return Response.redirect(url, 303);
}

export async function POST(request) {
  let db;
  let returnTo = null;
  try {
    const form = await request.formData();
    returnTo = safeReturnTo(form.get("return_to"));
    const store = await cookies();
    if (returnTo) store.set(returnToCookieName, returnTo, stateCookieOptions());
    db = await connectDatabase();
    const identityRow = await checkPasswordLogin(db, { email: form.get("email"), password: form.get("password") });
    await countMcpSignIn(returnTo);
    const next = await completeSignIn(db, {
      store,
      request,
      identity: { provider: identityRow.provider, login: identityRow.login, displayName: identityRow.display_name },
      existingIdentityRow: identityRow,
    });
    return Response.redirect(next, 303);
  } catch (error) {
    return back(request, error?.code === "PASSWORD_LOGIN_LOCKED" ? "locked" : "failed", returnTo);
  } finally {
    if (db) await db.end();
  }
}
