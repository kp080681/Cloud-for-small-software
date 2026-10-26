// Rate limits for the free App safety check. Fixed hourly windows, counted
// with an atomic upsert (same pattern as workspace_rate_limit_counters).
// Visitors are identified by a salted hash of their IP; the IP itself is
// never written anywhere.

import crypto from "node:crypto";

export const PER_VISITOR_PER_HOUR = 5;
export const GLOBAL_PER_HOUR = 300;

export function visitorKey(request, salt = process.env.APP_CHECK_SALT || process.env.DATABASE_URL || "utplava") {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  const ip = forwarded.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
  return `v:${crypto.createHmac("sha256", salt).update(ip).digest("hex").slice(0, 32)}`;
}

export function hourWindow(now = new Date()) {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  return start;
}

async function bump(db, key, windowStart) {
  const result = await db.query(
    `INSERT INTO public_check_rate_limits (key, window_start, count)
     VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = public_check_rate_limits.count + 1
     RETURNING count`,
    [key, windowStart],
  );
  return result.rows[0].count;
}

// Returns { allowed, retryAfterSeconds, remaining }.
export async function consumeCheckAllowance(db, key, now = new Date()) {
  const windowStart = hourWindow(now);
  const retryAfterSeconds = Math.max(60, Math.ceil((windowStart.getTime() + 3600_000 - now.getTime()) / 1000));
  const mine = await bump(db, key, windowStart);
  if (mine > PER_VISITOR_PER_HOUR) return { allowed: false, reason: "visitor", retryAfterSeconds, remaining: 0 };
  const all = await bump(db, "global", windowStart);
  if (all > GLOBAL_PER_HOUR) return { allowed: false, reason: "global", retryAfterSeconds, remaining: 0 };
  // Occasional cleanup of old windows; cheap thanks to the index.
  if (Math.random() < 0.02) await db.query(`DELETE FROM public_check_rate_limits WHERE window_start < now() - interval '2 days'`);
  return { allowed: true, retryAfterSeconds: 0, remaining: PER_VISITOR_PER_HOUR - mine };
}
