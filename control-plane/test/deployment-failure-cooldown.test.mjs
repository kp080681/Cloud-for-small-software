import assert from "node:assert/strict";
import test from "node:test";
import {
  AppPausedError,
  enforceFailureCooldown,
  failureCooldownDecision,
} from "../src/deployment-failure-cooldown.mjs";

test("fewer than the threshold recent failures does not pause", () => {
  const decision = failureCooldownDecision({ recentFailureCount: 2, threshold: 3 });
  assert.equal(decision.shouldPause, false);
  assert.equal(decision.observed, 2);
});

test("reaching the threshold triggers a pause with a plain-language reason", () => {
  const decision = failureCooldownDecision({ recentFailureCount: 3, threshold: 3 });
  assert.equal(decision.shouldPause, true);
  assert.match(decision.reason, /3 failed deployments/);
});

// A minimal fake replicating the two queries enforceFailureCooldown issues:
// reading the app's pause state, and counting recent FAILED deployments.
class FakeAppDb {
  constructor({ paused = null, recentFailureCount = 0 } = {}) {
    this.paused = paused;
    this.recentFailureCount = recentFailureCount;
    this.pauseCalls = [];
  }
  async query(sql, params) {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith("SELECT id, paused_at, paused_reason FROM apps")) {
      return {
        rowCount: 1,
        rows: [{ id: params[0], paused_at: this.paused, paused_reason: this.paused ? "already paused" : null }],
      };
    }
    if (text.startsWith("SELECT count(*)::int AS count")) {
      return { rowCount: 1, rows: [{ count: this.recentFailureCount }] };
    }
    if (text.startsWith("UPDATE apps SET paused_at=now()")) {
      this.pauseCalls.push({ appId: params[0], reason: params[1] });
      this.paused = new Date().toISOString();
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unhandled fake query: ${text}`);
  }
}

test("an app already paused blocks immediately without recounting failures", async () => {
  const db = new FakeAppDb({ paused: "2026-09-21T00:00:00.000Z" });
  await assert.rejects(
    enforceFailureCooldown(db, { appId: "app-1" }),
    (error) => error instanceof AppPausedError && error.message === "already paused",
  );
  assert.equal(db.pauseCalls.length, 0);
});

test("crossing the threshold pauses the app and blocks this same attempt", async () => {
  const db = new FakeAppDb({ recentFailureCount: 3 });
  await assert.rejects(enforceFailureCooldown(db, { appId: "app-1" }), AppPausedError);
  assert.equal(db.pauseCalls.length, 1);
  assert.equal(db.pauseCalls[0].appId, "app-1");
});

test("under the threshold allows the attempt and does not pause", async () => {
  const db = new FakeAppDb({ recentFailureCount: 1 });
  const result = await enforceFailureCooldown(db, { appId: "app-1" });
  assert.equal(result.allowed, true);
  assert.equal(db.pauseCalls.length, 0);
});
