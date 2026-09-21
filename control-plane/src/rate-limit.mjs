// Fixed-window per-workspace rate limiting. Deliberately simple (fixed
// windows, not sliding) to match the codebase's existing style and because a
// fixed window is sufficient to stop the abuse pattern this exists for:
// unthrottled repeated calls against a shared external credential (the
// platform's own GitHub App token) or a per-call-billed provider (AWS KMS).
//
// Draft limits (see the roadmap's Containment & Onboarding Spec for the
// full table) are starting points to tune once real usage exists, not final
// commitments.

export class RateLimitError extends Error {
  constructor(action, message, details = {}) {
    super(message);
    this.name = "RateLimitError";
    this.code = "WORKSPACE_RATE_LIMIT_REACHED";
    this.status = 429;
    this.action = action;
    this.details = details;
  }
}

// Truncates `now` down to the start of its fixed window. Pure and
// deterministic so it can be unit-tested without a clock or a database.
export function currentWindowStart(windowSeconds, now = Date.now()) {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error("windowSeconds must be a positive number");
  }
  const windowMs = windowSeconds * 1000;
  return new Date(Math.floor(now / windowMs) * windowMs).toISOString();
}

// Pure decision given an already-incremented count. Split out from the
// database call so the actual limit logic is testable without a database,
// matching the activeAppLimitDecision / activeDeploymentLimitDecision
// pattern in workspace-resource-policy.mjs.
export function rateLimitDecision({ count, limit, action }) {
  const observed = Number(count);
  const normalizedLimit = Number(limit);
  if (observed > normalizedLimit) {
    return {
      allowed: false,
      action,
      observed,
      limit: normalizedLimit,
      message: `Rate limit reached for ${action}: ${observed}/${normalizedLimit} in this window.`,
    };
  }
  return { allowed: true, action, observed, limit: normalizedLimit };
}

// Atomically increments this workspace+action's counter for the current
// window and throws RateLimitError if that increment pushed it past `limit`.
// The increment happens unconditionally (even on the call that trips the
// limit) so the counter also reflects rejected attempts, useful for spotting
// a workspace hammering past its limit rather than just the allowed calls.
export async function enforceRateLimit(db, { workspaceId, action, limit, windowSeconds, now = Date.now() }) {
  const windowStart = currentWindowStart(windowSeconds, now);
  const result = await db.query(
    `INSERT INTO workspace_rate_limit_counters (workspace_id, action, window_start, count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (workspace_id, action, window_start) DO UPDATE SET
         count = workspace_rate_limit_counters.count + 1,
         updated_at = now()
       RETURNING count`,
    [workspaceId, action, windowStart],
  );
  const decision = rateLimitDecision({ count: result.rows[0].count, limit, action });
  if (!decision.allowed) {
    throw new RateLimitError(action, decision.message, decision);
  }
  return decision;
}
