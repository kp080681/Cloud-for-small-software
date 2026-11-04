import assert from "node:assert/strict";
import test from "node:test";
import { funnelClientLabel, recordFunnelStep } from "../src/server/mcp-funnel.mjs";

test("funnel steps are counted per day with only a short client label, and never throw", async () => {
  const calls = [];
  const db = { query: (sql, params) => { calls.push(params); return Promise.resolve({ rows: [] }); } };
  await recordFunnelStep(db, { step: "welcome_viewed", client: "Claude" }, new Date("2026-11-04T10:00:00Z"));
  await recordFunnelStep(db, { step: "not_a_step", client: "Claude" });
  assert.deepEqual(calls, [["2026-11-04", "welcome_viewed", "Claude"]]);
  const broken = { query: () => Promise.reject(new Error("table missing")) };
  await recordFunnelStep(broken, { step: "consent_viewed", client: "Claude" });
  await recordFunnelStep(null, { step: "consent_viewed", client: "Claude" });
});

test("client labels are bounded and fall back safely", () => {
  assert.equal(funnelClientLabel({}), "unknown");
  assert.equal(funnelClientLabel({ clientName: "Glama" }), "app: Glama");
  assert.equal(funnelClientLabel({ recognisedLabel: "Claude" }), "Claude");
  assert.ok(funnelClientLabel({ clientName: "x".repeat(500) }).length <= 80);
});
