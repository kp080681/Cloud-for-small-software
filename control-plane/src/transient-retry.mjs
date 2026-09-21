// A small, generic retry helper for transient failures — network blips,
// provider rate limits — that resolve themselves if you just wait a moment
// and try again. Deliberately generic (not Vercel-specific) so it can wrap
// any async call given a predicate for "is this error worth retrying".
//
// Kept separate from Trigger.dev's own task-level `retry` option (which
// re-runs the whole task function on an *uncaught* exception): that
// mechanism is coarse — it re-does everything the task already did before
// the failure. This helper retries just the one flaky call, silently, so a
// customer never sees a deployment fail over something that resolved itself
// on the second attempt a few seconds later.

// Exponential backoff, pure and deterministic so it's testable without a
// clock. attempt is 1-indexed (the first retry is attempt 1).
export function transientRetryDelayMs({ attempt, baseDelayMs = 500, maxDelayMs = 8000 }) {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(exponential, maxDelayMs);
}

async function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls fn() (passed the current attempt number, 1-indexed) and retries it
 * with backoff if isRetryable(error) is true and attempts remain. Rethrows
 * the original error unchanged on the final attempt or when isRetryable
 * returns false, so the caller's existing error handling (classification,
 * recording a friendly failure) is completely unchanged for the case where
 * retrying doesn't help — this only changes behavior for errors judged
 * worth a second try.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{
 *   maxAttempts?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   isRetryable?: (error: any) => boolean,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {Promise<T>}
 */
export async function withTransientRetry(
  fn,
  { maxAttempts = 3, baseDelayMs = 500, maxDelayMs = 8000, isRetryable = () => false, sleep = defaultSleep } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      const attemptsRemain = attempt < maxAttempts;
      if (!attemptsRemain || !isRetryable(error)) throw error;
      await sleep(transientRetryDelayMs({ attempt, baseDelayMs, maxDelayMs }));
    }
  }
  // Unreachable given the loop above always returns or throws, but keeps
  // the function's return type honest for any future refactor.
  throw new Error("withTransientRetry: exhausted attempts without a result or error");
}
