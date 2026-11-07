// Daily counts of how far people get when connecting an AI tool (2026-11-04),
// so the founder can see where strangers stop: welcome page, GitHub sign-in,
// consent screen. Numbers only, no personal data. Best-effort: counting must
// never affect the page or redirect it sits in.

export const FUNNEL_STEPS = new Set([
  "welcome_viewed",
  "signin_started",
  "consent_viewed",
  // 2026-11-07: a client (Superhuman) registered 3 times and never reached
  // the welcome page; Vercel keeps request logs for an hour, so record
  // where connections fail, durably. Labels are reason codes, never data.
  "authorize_requested",
  "authorize_rejected",
  "token_issued",
  "token_rejected",
]);

// Registered client name for a client_id, for funnel labels only.
export async function clientLabelFor(db, clientId) {
  if (!db || typeof clientId !== "string" || !clientId) return "unknown";
  const r = await db.query(`SELECT name FROM mcp_clients WHERE client_id = $1`, [clientId]).catch(() => null);
  return funnelClientLabel({ clientName: r?.rows?.[0]?.name ?? null });
}

export function funnelClientLabel({ recognisedLabel, clientName } = {}) {
  const label = recognisedLabel || (clientName ? `app: ${String(clientName)}` : "unknown");
  return label.replace(/\s+/g, " ").trim().slice(0, 80) || "unknown";
}

export async function recordFunnelStep(db, { step, client }, now = new Date()) {
  if (!db || !FUNNEL_STEPS.has(step)) return;
  const day = now.toISOString().slice(0, 10);
  await db
    .query(
      `INSERT INTO mcp_funnel_daily (day, step, client, hits)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (day, step, client) DO UPDATE SET hits = mcp_funnel_daily.hits + 1`,
      [day, step, funnelClientLabel({ recognisedLabel: client })],
    )
    .catch(() => {});
}
