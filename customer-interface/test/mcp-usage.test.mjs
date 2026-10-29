import assert from "node:assert/strict";
import test from "node:test";
import { recordToolCall } from "../src/server/mcp-usage.mjs";

test("tool calls are counted per day, never with arguments, and never throw", async () => {
  const calls = [];
  const db = { query: (sql, params) => { calls.push(params); return Promise.resolve({ rows: [] }); } };
  await recordToolCall(db, { workspaceId: "w1", toolName: "deploy", ok: true }, new Date("2026-10-29T10:00:00Z"));
  await recordToolCall(db, { workspaceId: "w1", toolName: "deploy", ok: false }, new Date("2026-10-29T11:00:00Z"));
  assert.deepEqual(calls, [["2026-10-29", "w1", "deploy", 1, 0], ["2026-10-29", "w1", "deploy", 0, 1]]);
  const broken = { query: () => Promise.reject(new Error("table missing")) };
  await recordToolCall(broken, { workspaceId: "w1", toolName: "deploy", ok: true });
});
