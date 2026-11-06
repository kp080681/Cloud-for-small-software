import { redirect } from "next/navigation";
import { getCustomerShell } from "@/src/server/customer-shell.mjs";
import { safeReturnTo } from "@/src/server/mcp-registration.mjs";
import { Brand } from "../../ui.js";

export const dynamic = "force-dynamic";

// For accounts Utplava created (app-directory reviewers, test accounts).
// There is no sign-up here on purpose.
export default async function EmailSignInPage({ searchParams }) {
  const query = await searchParams;
  const returnTo = safeReturnTo(typeof query?.return_to === "string" ? query.return_to : null);
  const shell = await getCustomerShell({});
  if (shell.authenticated) redirect(returnTo || "/");
  const error = query?.error === "locked"
    ? "Too many wrong tries. Wait 10 minutes and try again."
    : query?.error === "failed"
      ? "That email and password don't match an account."
      : null;
  return (
    <main className="sign-in">
      <Brand />
      <section className="panel">
        <h2>Sign in with email</h2>
        <p className="muted">For accounts Utplava set up for you, such as test and review accounts.</p>
        <form className="email-sign-in" action="/api/auth/password" method="post">
          {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
          <label>
            <span>Email</span>
            <input type="email" name="email" autoComplete="username" required maxLength={200} />
          </label>
          <label>
            <span>Password</span>
            <input type="password" name="password" autoComplete="current-password" required maxLength={200} />
          </label>
          {error ? <p className="upload-error" role="alert">{error}</p> : null}
          <button type="submit" className="button primary">Sign in</button>
        </form>
        <p className="sign-in-notes">
          <a href={returnTo ? `/?return_to=${encodeURIComponent(returnTo)}` : "/"}>Back to other ways to sign in</a>
        </p>
      </section>
    </main>
  );
}
