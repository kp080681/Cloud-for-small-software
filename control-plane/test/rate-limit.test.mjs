import assert from "node:assert/strict";
import test from "node:test";
import { currentWindowStart, enforceRateLimit, RateLimitError, rateLimitDecision } from "../src/rate-limit.mjs";

test("currentWindowStart truncates to a stable bucket boundary", () => {
  const oneHourMs = 60 * 60 * 1000;
  const start = new Date("2026-09-21T10:00:00.000Z").getTime();

  assert.equal(currentWindowStart(3600, start), "2026-09-21T10:00:00.000Z");
  assert.equal(currentWindowStart(3600, start + 59 * 60 * 1000), "2026-09-21T10:00:00.000Z");
  assert.equal(currentWindowStart(3600, start + oneHourMs), "2026-09-21T11:00:00.000Z");
});

test("currentWindowStart rejects a non-positive window", () => {
  assert.throws(() => currentWindowStart(0), /positive number/);
  assert.throws(() => currentWindowStart(-5), /positive number/);
});

test("a count at or under the limit is allowed", () => {
  assert.equal(rateLimitDecision({ count: 1, limit: 10, action: "deploy" }).allowed, true);
  assert.equal(rateLimitDecision({ count: 10, limit: 10, action: "deploy" }).allowed, true);
});

test("a count over the limit is blocked with the observed/limit reported", () => {
  const decision = rateLimitDecision({ count: 11, limit: 10, action: "deploy" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.observed, 11);
  assert.equal(decision.limit, 10);
  assert.match(decision.message, /11\/10/);
});

test("the same instant always maps to the same window regardless of call order", () => {
  const now = Date.now();
  assert.equal(currentWindowStart(60, now), currentWindowStart(60, now));
});

// A minimal fake replicating the real SQL's atomic upsert semantics
// (INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count),
// so enforceRateLimit's actual integration with a query interface is
// exercised end to end, not just its pure decision logic.
class FakeCounterDb {
  constructor() {
    this.counters = new Map();
  }
  async query(sql, [workspaceId, action, windowStart]) {
    const key = `${workspaceId}:${action}:${windowStart}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return { rowCount: 1, rows: [{ count: next }] };
  }
}

test("enforceRateLimit allows exactly `limit` calls in a window and blocks the next", async () => {
  const db = new FakeCounterDb();
  const now = Date.now();
  for (let i = 0; i < 10; i += 1) {
    await enforceRateLimit(db, { workspaceId: "ws-1", action: "deploy", limit: 10, windowSeconds: 3600, now });
  }
  await assert.rejects(
    enforceRateLimit(db, { workspaceId: "ws-1", action: "deploy", limit: 10, windowSeconds: 3600, now }),
    (error) => error instanceof RateLimitError && error.code === "WORKSPACE_RATE_LIMIT_REACHED" && error.details.observed === 11,
  );
});

test("enforceRateLimit resets once a new window starts", async () => {
  const db = new FakeCounterDb();
  const windowStart = Date.now();
  for (let i = 0; i < 5; i += 1) {
    await enforceRateLimit(db, { workspaceId: "ws-1", action: "deploy", limit: 5, windowSeconds: 60, now: windowStart });
  }
  // 61 seconds later is a new fixed window, so this should succeed cleanly.
  const decision = await enforceRateLimit(db, {
    workspaceId: "ws-1",
    action: "deploy",
    limit: 5,
    windowSeconds: 60,
    now: windowStart + 61_000,
  });
  assert.equal(decision.allowed, true);
});

test("enforceRateLimit tracks separate workspaces and actions independently", async () => {
  const db = new FakeCounterDb();
  const now = Date.now();
  for (let i = 0; i < 5; i += 1) {
    await enforceRateLimit(db, { workspaceId: "ws-1", action: "deploy", limit: 5, windowSeconds: 3600, now });
  }
  // A different workspace, and a different action on the same workspace,
  // must not be affected by ws-1's deploy count.
  const otherWorkspace = await enforceRateLimit(db, { workspaceId: "ws-2", action: "deploy", limit: 5, windowSeconds: 3600, now });
  const otherAction = await enforceRateLimit(db, { workspaceId: "ws-1", action: "redeploy", limit: 5, windowSeconds: 3600, now });
  assert.equal(otherWorkspace.allowed, true);
  assert.equal(otherAction.allowed, true);
});
