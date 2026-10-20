// Emails the founder when something worth knowing happens: a new sign-up,
// or a new user starting their first deploy (2026-10-20).
//
// Sent through Resend. Setup is two Vercel env vars on the `utplava`
// project: RESEND_API_KEY and OWNER_ALERT_EMAIL (the address the Resend
// account was created with — until a sending domain is verified, Resend's
// shared sender only delivers to that address). OWNER_ALERT_FROM is
// optional. With either required var missing, alerts are silently off.
//
// An alert must never break the thing it reports on, so this never throws
// and gives up after a few seconds.

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 4000;

export async function sendOwnerAlert({ subject, text }, { env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = env.RESEND_API_KEY;
  const to = env.OWNER_ALERT_EMAIL;
  if (!apiKey || !to) return { sent: false, reason: "not_configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.OWNER_ALERT_FROM || "Utplava alerts <onboarding@resend.dev>",
        to: to.split(",").map((address) => address.trim()).filter(Boolean),
        subject,
        text,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`owner alert not sent: Resend answered ${response.status}`);
      return { sent: false, reason: `http_${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    console.warn(`owner alert not sent: ${error?.name || "error"}`);
    return { sent: false, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}

async function customerSummary(db, customerId) {
  const result = await db.query(
    `SELECT login, display_name,
            (SELECT count(*) FROM customer_identities)::int AS total_users
       FROM customer_identities WHERE id = $1`,
    [customerId],
  );
  return result.rows[0] ?? null;
}

function istTime(now = new Date()) {
  return now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
}

export async function alertNewSignup(db, { customerId }, options = {}) {
  try {
    const who = await customerSummary(db, customerId);
    if (!who) return { sent: false, reason: "unknown_customer" };
    const name = who.display_name && who.display_name !== who.login ? `${who.display_name} (@${who.login})` : `@${who.login}`;
    return await sendOwnerAlert(
      {
        subject: `New Utplava sign-up: ${name}`,
        text: [
          `${name} just signed up for Utplava.`,
          "",
          `GitHub profile: https://github.com/${who.login}`,
          `Signed up: ${istTime()} IST`,
          `Total users so far: ${who.total_users}`,
        ].join("\n"),
      },
      options,
    );
  } catch {
    return { sent: false, reason: "error" };
  }
}

export async function alertFirstDeployStarted(db, { customerId, workspaceId, appId, deploymentId }, options = {}) {
  try {
    // Only the workspace's very first deploy is news; every later one is routine.
    const earlier = await db.query(
      `SELECT 1 FROM deployments
        WHERE workspace_id = $1 AND id <> $2 AND orchestrator_run_id IS NOT NULL
        LIMIT 1`,
      [workspaceId, deploymentId],
    );
    if (earlier.rowCount > 0) return { sent: false, reason: "not_first" };
    const who = await customerSummary(db, customerId);
    const app = await db.query(
      `SELECT a.name, r.full_name
         FROM apps a LEFT JOIN github_repositories r ON r.id = a.repository_id
        WHERE a.id = $1`,
      [appId],
    );
    const login = who?.login ?? "someone";
    const repo = app.rows[0]?.full_name || app.rows[0]?.name || "an app";
    return await sendOwnerAlert(
      {
        subject: `@${login} is deploying their first app on Utplava`,
        text: [
          `@${login} just started their first deploy.`,
          "",
          `Repository: https://github.com/${repo}`,
          `Started: ${istTime()} IST`,
          "",
          "A good moment to check it went live, and say hello if it didn't.",
        ].join("\n"),
      },
      options,
    );
  } catch {
    return { sent: false, reason: "error" };
  }
}
