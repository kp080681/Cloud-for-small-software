import assert from "node:assert/strict";
import test from "node:test";
import { HelpRequestError, saveHelpRequest, validateHelpRequest } from "../src/server/app-check-help.mjs";

test("help requests need a real-looking email and a checkable address", () => {
  assert.deepEqual(validateHelpRequest({ email: " Me@Example.com ", url: "myapp.lovable.app", score: 6 }), { email: "me@example.com", target: "https://myapp.lovable.app", score: 6 });
  assert.throws(() => validateHelpRequest({ email: "nope", url: "a.com" }), HelpRequestError);
  assert.throws(() => validateHelpRequest({ email: "a@b.com", url: "http://127.0.0.1" }), HelpRequestError);
  assert.equal(validateHelpRequest({ email: "a@b.com", url: "a.com", score: 99 }).score, null);
});

test("a saved request is stored and the founder is emailed", async () => {
  const queries = [];
  const alerts = [];
  const db = { query: async (sql, params) => { queries.push(params); return { rows: [] }; } };
  await saveHelpRequest(db, { email: "a@b.com", target: "https://x.com", score: 4 }, { alert: async (m) => { alerts.push(m); return { sent: true }; } });
  assert.deepEqual(queries[0], ["a@b.com", "https://x.com", 4]);
  assert.match(alerts[0].subject, /a@b\.com wants help with https:\/\/x\.com/);
});
