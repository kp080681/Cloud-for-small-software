import { tasks } from "@trigger.dev/sdk";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");
if (!process.env.TRIGGER_SECRET_KEY) throw new Error("Missing required environment variable: TRIGGER_SECRET_KEY");

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  const runtimeResult = await db.query(
    `SELECT count(*)::int AS count
       FROM app_runtimes
      WHERE provider = 'vercel'`,
  );
  const handle = await tasks.trigger("ssc-control-plane-detect-orphan-resources", {});

  console.log(JSON.stringify({
    result: "NODE_04_19_ORPHAN_RESOURCE_DETECTION_TRIGGERED",
    vercelRuntimeCount: Number(runtimeResult.rows[0].count),
    triggerRunId: handle.id,
    destructiveOperationExecuted: false,
    providerResourcesMutated: false,
  }, null, 2));
} finally {
  await db.end();
}
