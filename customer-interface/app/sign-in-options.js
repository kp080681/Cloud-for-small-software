import { isGoogleSignInConfigured } from "@/src/server/google-oauth.mjs";

// Every way into Utplava, in one place (2026-11-06). Google first: most
// people have it, and uploads no longer need GitHub. GitHub for people whose
// code is there. Email only for accounts Utplava created (reviewers, tests).
export function SignInOptions({ returnTo = null }) {
  const q = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "";
  const google = isGoogleSignInConfigured();
  return (
    <div className="sign-in-options">
      {google ? (
        <a className="button primary" href={`/api/auth/google/start${q}`}>Continue with Google</a>
      ) : null}
      <a className={google ? "button" : "button primary"} href={`/api/auth/github/start${q}`}>Continue with GitHub</a>
      <small className="sign-in-email">
        Have a test or review account? <a href={`/sign-in/email${q}`}>Sign in with email</a>
      </small>
    </div>
  );
}
