import "dotenv/config";
import { createDatabase, deleteDatabase, getConnectionBinding } from "../03-managed-postgres/postgres-adapter/neon-postgres.mjs";

const name = `ssc-spike-d-state-${Date.now()}`;
const created = await createDatabase({ name });
const projectId = created.project.id;

try {
  const binding = await getConnectionBinding(projectId);
  console.log(JSON.stringify({
    result: "SPIKE_D_STATE_READY",
    neonProjectId: projectId,
    databaseUrl: binding.connectionUri,
    warning: "DATABASE_URL is sensitive. Load it into Trigger.dev and local PowerShell; do not commit it.",
  }, null, 2));
} catch (error) {
  await deleteDatabase(projectId);
  throw error;
}
