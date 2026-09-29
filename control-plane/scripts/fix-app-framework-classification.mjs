import pg from "pg";

// One-time operator correction: an app's framework/runtime is set once,
// at its original analysis, and never re-computed by a build retry
// (prepare-build-input.ts only ever carries the app's existing stored
// value forward — confirmed by reading its source directly). A detection
// logic fix (project-detection.mjs) only affects apps analyzed AFTER the
// fix ships; an app already analyzed before then keeps its stale
// classification until corrected directly, or re-analyzed from scratch.
//
// This updates exactly one app's stored framework/runtime to values
// already confirmed correct by hand (see today's static-site detection
// fix and its test coverage) — not a guess, not applied broadly.
for (const name of ["DATABASE_URL", "APP_ID", "FRAMEWORK", "RUNTIME"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const result = await db.query(
    `UPDATE apps SET framework = $1, runtime = $2, updated_at = now() WHERE id = $3 RETURNING id, name, framework, runtime`,
    [process.env.FRAMEWORK, process.env.RUNTIME, process.env.APP_ID],
  );
  console.log(JSON.stringify({ result: result.rowCount > 0 ? "UPDATED" : "APP_NOT_FOUND", app: result.rows[0] ?? null }, null, 2));
} finally {
  await db.end();
}
