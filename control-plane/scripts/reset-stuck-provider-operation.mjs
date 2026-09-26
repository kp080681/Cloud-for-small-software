import pg from "pg";

// One-time operator fix: resets a deployment_provider_operations row stuck
// at status='CREATE_REQUESTED' back to 'FAILED', so claimProviderCreateOperation
// (which only claims from INTENT_RECORDED or FAILED) can claim it again on
// the next resume attempt.
//
// This is exactly the leftover state a genuine hang leaves behind: the very
// first real attempt to create a Vercel deployment for this app happened
// before execute-build.ts had any timeout on its Vercel API call, hung
// forever mid-request, and never got the chance to update this row again.
// Every subsequent resume attempt since then — even after the timeout fix —
// correctly saw CREATE_REQUESTED and safely deferred (buildRecoveryAction's
// "pending" branch) rather than risk creating a duplicate Vercel
// deployment. That deferral is the right safety behavior; it just needs
// this one stale record cleared for this one specific deployment.
//
// Only ever operates on a row already confirmed stuck (status =
// CREATE_REQUESTED with no provider_resource_id set, meaning nothing was
// ever actually created on Vercel's side to worry about orphaning) — never
// touches a row that has a provider_resource_id, or any other status.
for (const name of ["DATABASE_URL", "DEPLOYMENT_ID"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const deploymentId = process.env.DEPLOYMENT_ID;
  const current = await db.query(
    `SELECT id, status, provider_resource_id, updated_at FROM deployment_provider_operations WHERE deployment_id = $1 AND operation_type = 'vercel-create-deployment'`,
    [deploymentId],
  );
  if (current.rowCount === 0) {
    console.log(JSON.stringify({ result: "NO_OPERATION_FOUND", deploymentId }, null, 2));
  } else {
    const row = current.rows[0];
    if (row.status !== "CREATE_REQUESTED" || row.provider_resource_id) {
      console.log(JSON.stringify({ result: "NOT_STUCK_AS_EXPECTED", deploymentId, currentRow: row }, null, 2));
    } else {
      const updated = await db.query(
        `UPDATE deployment_provider_operations
            SET status = 'FAILED', updated_at = now(), metadata = metadata || '{"resetReason":"stuck_create_requested_operator_reset"}'::jsonb
          WHERE id = $1 AND status = 'CREATE_REQUESTED' AND provider_resource_id IS NULL
          RETURNING id, status`,
        [row.id],
      );
      console.log(JSON.stringify({ result: "RESET", deploymentId, updated: updated.rows[0] }, null, 2));
    }
  }
} finally {
  await db.end();
}
