// Automatic anomaly-based suspension for a failure-looping app. Deliberately
// scoped to what's answerable from data the platform already has (the
// deployments table's own FAILED rows) — no new event-recording plumbing,
// no hook into the several trigger tasks that can independently set a
// deployment to FAILED. Instead this checks, before any NEW attempt is
// allowed, whether the app has already failed too many times recently; if
// so it pauses the app right then and blocks the attempt. This is a
// stickier, friendlier-to-the-customer layer on top of (not a replacement
// for) the existing per-lineage retry-depth cap and the redeploy rate limit:
// those bound waste per attempt chain and per hour respectively, but reset
// on a fresh redeploy; this produces a lasting, clearly-explained stop once
// a pattern of repeated failure is evident, exactly the friendly-over-silent
// behavior the platform is meant to default to.

export class AppPausedError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = "AppPausedError";
    this.code = "APP_PAUSED";
    this.status = 409;
    this.details = details;
  }
}

export const DEFAULT_FAILURE_COOLDOWN_WINDOW_MINUTES = 15;
export const DEFAULT_FAILURE_COOLDOWN_THRESHOLD = 3;

// Pure: given an already-observed recent failure count, decide whether this
// crosses the threshold that should trigger a pause. Split out from the
// database call so the actual anomaly logic is testable without a database.
export function failureCooldownDecision({ recentFailureCount, threshold = DEFAULT_FAILURE_COOLDOWN_THRESHOLD }) {
  const observed = Number(recentFailureCount);
  if (observed >= threshold) {
    return {
      shouldPause: true,
      observed,
      threshold,
      reason: `Paused after ${observed} failed deployments in the last ${DEFAULT_FAILURE_COOLDOWN_WINDOW_MINUTES} minutes.`,
    };
  }
  return { shouldPause: false, observed, threshold };
}

// Call before creating any new deployment attempt (retry or redeploy) for an
// existing app. Throws AppPausedError, and pauses the app in the same call if
// this is the attempt that crosses the threshold, if the app is already
// paused or this attempt's recent-failure count crosses the threshold;
// otherwise returns { allowed: true }.
export async function enforceFailureCooldown(
  db,
  { appId, windowMinutes = DEFAULT_FAILURE_COOLDOWN_WINDOW_MINUTES, threshold = DEFAULT_FAILURE_COOLDOWN_THRESHOLD },
) {
  const appResult = await db.query(`SELECT id, paused_at, paused_reason FROM apps WHERE id=$1`, [appId]);
  if (appResult.rowCount === 0) throw new Error(`App not found: ${appId}`);
  const app = appResult.rows[0];

  if (app.paused_at) {
    throw new AppPausedError(app.paused_reason || "This app is paused pending manual review.", {
      pausedAt: app.paused_at,
    });
  }

  const failureResult = await db.query(
    `SELECT count(*)::int AS count
       FROM deployments
      WHERE app_id=$1
        AND status='FAILED'
        AND updated_at > now() - ($2 || ' minutes')::interval`,
    [appId, windowMinutes],
  );
  const decision = failureCooldownDecision({ recentFailureCount: failureResult.rows[0].count, threshold });

  if (decision.shouldPause) {
    await db.query(
      `UPDATE apps SET paused_at=now(), paused_reason=$2, updated_at=now() WHERE id=$1`,
      [appId, decision.reason],
    );
    throw new AppPausedError(decision.reason, { observed: decision.observed, threshold: decision.threshold });
  }

  return { allowed: true, observed: decision.observed, threshold: decision.threshold };
}
