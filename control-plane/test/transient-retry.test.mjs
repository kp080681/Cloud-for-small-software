import assert from "node:assert/strict";
import test from "node:test";
import { transientRetryDelayMs, withTransientRetry } from "../src/transient-retry.mjs";

test("transientRetryDelayMs backs off exponentially, capped at maxDelayMs", () => {
  assert.equal(transientRetryDelayMs({ attempt: 1, baseDelayMs: 500, maxDelayMs: 8000 }), 500);
  assert.equal(transientRetryDelayMs({ attempt: 2, baseDelayMs: 500, maxDelayMs: 8000 }), 1000);
  assert.equal(transientRetryDelayMs({ attempt: 3, baseDelayMs: 500, maxDelayMs: 8000 }), 2000);
  assert.equal(transientRetryDelayMs({ attempt: 10, baseDelayMs: 500, maxDelayMs: 8000 }), 8000);
});

function fakeSleepRecorder() {
  const calls = [];
  return { sleep: async (ms) => calls.push(ms), calls };
}

test("a transient error that resolves on retry never surfaces to the caller", async () => {
  const { sleep, calls } = fakeSleepRecorder();
  let attempts = 0;
  const result = await withTransientRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("rate limited"), { status: 429 });
      return { ok: true };
    },
    { maxAttempts: 3, isRetryable: (error) => error.status === 429, sleep },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 3);
  assert.equal(calls.length, 2, "should have slept once between each of the two failed attempts");
});

test("a non-retryable error is rethrown immediately, with no sleep and no extra attempts", async () => {
  const { sleep, calls } = fakeSleepRecorder();
  let attempts = 0;
  await assert.rejects(
    withTransientRetry(
      async () => {
        attempts += 1;
        throw Object.assign(new Error("unauthorized"), { status: 401 });
      },
      { maxAttempts: 3, isRetryable: (error) => error.status === 429, sleep },
    ),
    (error) => error.status === 401,
  );
  assert.equal(attempts, 1);
  assert.equal(calls.length, 0);
});

test("a retryable error that never resolves is rethrown unchanged after exhausting attempts", async () => {
  const { sleep, calls } = fakeSleepRecorder();
  let attempts = 0;
  const rateLimitError = () => Object.assign(new Error("still rate limited"), { status: 429 });
  await assert.rejects(
    withTransientRetry(
      async () => {
        attempts += 1;
        throw rateLimitError();
      },
      { maxAttempts: 3, isRetryable: (error) => error.status === 429, sleep },
    ),
    (error) => error.status === 429,
  );
  assert.equal(attempts, 3);
  assert.equal(calls.length, 2, "sleeps between attempts, but not after the final failed attempt");
});

test("no isRetryable predicate defaults to never retrying, preserving today's behavior", async () => {
  const { sleep } = fakeSleepRecorder();
  let attempts = 0;
  await assert.rejects(
    withTransientRetry(
      async () => {
        attempts += 1;
        throw new Error("boom");
      },
      { maxAttempts: 3, sleep },
    ),
  );
  assert.equal(attempts, 1);
});
