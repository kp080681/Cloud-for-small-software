import { task } from "@trigger.dev/sdk";
import pg from "pg";
import { loadDeploymentDiagnosticContext } from "../src/deployment-diagnostic-context.mjs";
import { normalizeDeploymentDiagnostic } from "../src/deployment-diagnostics.mjs";
import { normalizeDeploymentTimeline } from "../src/deployment-timeline.mjs";

const { Client } = pg;

async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

export const getDeploymentTimeline = task({
  id: "ssc-control-plane-get-deployment-timeline",
  retry: { maxAttempts: 1 },
  run: async (payload: { deploymentId: string }) => {
    return await withDb(async (db) => {
      const context = await loadDeploymentDiagnosticContext(db, payload.deploymentId, { eventLimit: null });
      const diagnostic = normalizeDeploymentDiagnostic(context);
      const timeline = normalizeDeploymentTimeline(context, diagnostic);

      return {
        result: "NODE_04_21_DEPLOYMENT_TIMELINE",
        ...timeline,
        rawBuildLogsReturned: false,
        providerResponseBodiesReturned: false,
        tokensPrinted: false,
        secretsPrinted: false,
        providerResourcesMutated: false,
        destructiveOperationExecuted: false,
      };
    });
  },
});
