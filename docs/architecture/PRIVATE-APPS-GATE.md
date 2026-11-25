# Private apps: the sign-in gate (design, 25 Nov 2026)

Status: agreed with Kiran on 25 Nov 2026, not built yet.

## Why
YC's Fall 2026 Request for Startups, "A Cloud for Small Software" (Pete Koomen), asks for a
place where an agent-built app goes from code to a shared, secured URL in one step: zero-config
sign-in for every app, invites by email, roles, team spaces, an audit log. utplava already has
the deploy half. This is the missing "private by default" half, and the first piece of it.

Promise to users: **"Make it private. Only the people you invite can open it."** No code changes
in the user's app, any framework (Next.js, Node, plain HTML).

## What the user sees
1. On the app's page (and through MCP: "make my app private, invite asha@example.com"):
   a switch **Public / Private** and an **Invite people** box (emails).
2. An invited person opens the link, sees a calm utplava sign-in page with the app's name,
   types their email, gets a one-time link (or signs in with Google), and lands in the app.
3. Anyone not on the list sees "This app is private. Ask the owner for an invite."
4. The owner sees who has access, can remove anyone, and sees who opened the app and when.

## How it works
Every customer app is its own Vercel project with `<slug>.utplava.dev` attached; utplava.dev
DNS is on Vercel. For a private app:

1. **Lock the app itself.** Set the app's Vercel project to Deployment Protection scope
   "All Deployments" with Vercel Authentication (free on every plan). Every URL of the project,
   including `*.vercel.app`, then refuses the public. Create a Protection Bypass for Automation
   secret for the project, store it encrypted (KMS, like other secrets).
2. **Put the gate in front.** A new utplava Vercel project, `utplava-gate`, serves private apps.
   Move `<slug>.utplava.dev` (and any custom domain) from the app's project to the gate project.
3. **The gate** (edge function on every request):
   - Looks up the host -> app (cached), checks the visitor's gate session cookie
     (HttpOnly, Secure, SameSite=Lax, signed, scoped to that host, 7-day expiry).
   - No valid session: show the sign-in page (email one-time link via Resend; Google sign-in later).
   - Valid session and the email is on the app's access list: forward the request to the app's
     production deployment URL with the `x-vercel-protection-bypass` header, stream the response
     back. Strip the gate cookie before forwarding; pass `x-utplava-user-email` so apps can read who
     is signed in if they want to.
   - Record access (app, email, time) for the owner's "who opened it" list.
4. **Make public again**: reverse the steps (domain back to the app project, protection off).

## Data
- `app_access` (application_id, email, role [viewer for now], invited_by, created_at, revoked_at)
- `app_gate_login_tokens` (hashed one-time token, email, application_id, expires_at, used_at)
- `app_gate_sessions` (hashed session id, email, application_id, expires_at, revoked_at)
- `app_access_events` (application_id, email, event [signed_in, opened, denied], at)
- `applications.visibility` ('public' | 'private')

## Security notes
- The bypass secret never leaves the server side of the gate; rotate it on every switch back to private.
- One-time links: single use, 15-minute expiry, hashed at rest, rate-limited per email and per IP.
- Session cookie per host, so one app's session never opens another app.
- Removing someone revokes their sessions immediately.
- The gate must not become an open proxy: it only forwards to the deployment URL stored for that host.
- Limits: no WebSockets through the gate in v1; very large uploads may hit edge limits (document it).

## Build order
1. Tables + control-plane task to switch an app private/public (protection, bypass secret, domain move).
2. The gate project: host lookup, sign-in page, one-time email links, session, forwarding.
3. Dashboard: switch, invite box, access list, "who opened it".
4. MCP tools: make_private, make_public, invite, remove_access, list_access.
5. Tests for each, then a live test on one of Kiran's own apps before any customer app.

Later (also in the YC list): roles beyond viewer, team spaces, audit log export, Google sign-in on
the gate, alerts.
