import { createDatabase, deleteDatabase, getConnectionBinding, getDatabase } from "./postgres-adapter/neon-postgres.mjs";
import { createAutomationBypass, deleteRuntime, ensureRuntime, getCandidateUrl, setEnvironment, startDeployment, waitForDeployment } from "../01-runtime-only/runtime-adapter/vercel-runtime.mjs";

const repository = "kp080681/Cloud-for-small-software";
const [owner, repo] = repository.split("/");
const ref = "main";
const sha = process.env.SPIKE_GIT_SHA;
const rootDirectory = "spikes/03-managed-postgres/test-app";
const marker = `spike-c-${Date.now()}`;
const resourceName = `ssc-spike-c-${Date.now()}`;

if (!sha) throw new Error("SPIKE_GIT_SHA is required");

let projectId;
let runtimeId;
const timings = {};
function begin(name) { timings[name] = { startedAt: Date.now() }; }
function end(name) { timings[name].finishedAt = Date.now(); timings[name].durationMs = timings[name].finishedAt - timings[name].startedAt; }

try {
  begin("databaseProvisioning");
  const database = await createDatabase({ name: resourceName });
  projectId = database.project.id;
  const persisted = await getDatabase(projectId);
  if (!persisted?.id) throw new Error("Created Neon database could not be reconciled");
  const binding = await getConnectionBinding(projectId);
  end("databaseProvisioning");

  begin("runtimeProvisioning");
  const runtime = await ensureRuntime({ name: resourceName, repository, rootDirectory });
  runtimeId = runtime.resource.id;
  const protectionBypass = await createAutomationBypass(runtimeId);
  end("runtimeProvisioning");

  begin("configuration");
  await setEnvironment({ projectId: runtimeId, key: "APP_BUILD_MARKER", value: marker });
  await setEnvironment({ projectId: runtimeId, key: "DATABASE_URL", value: binding.connectionUri });
  end("configuration");

  begin("deployment");
  const created = await startDeployment({ name: resourceName, projectId: runtimeId, owner, repo, ref, sha, rootDirectory });
  const ready = await waitForDeployment(created.id);
  end("deployment");

  const baseUrl = getCandidateUrl(ready);

  begin("databaseReadWriteVerification");
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { "x-vercel-protection-bypass": protectionBypass, Accept: "application/json" },
  });
  const health = await response.json();
  if (!response.ok || health?.ok !== true || health?.marker !== marker || health?.database !== "read-write-verified") {
    throw new Error(`Database health verification failed with HTTP ${response.status}`);
  }
  end("databaseReadWriteVerification");

  console.log(JSON.stringify({
    result: "SPIKE_C_PASS",
    repository,
    sha,
    neonProjectId: projectId,
    runtimeProjectId: runtimeId,
    deploymentId: ready.id,
    url: baseUrl,
    health,
    databaseBinding: {
      branchId: binding.branchId,
      endpointId: binding.endpointId,
      databaseName: binding.databaseName,
      roleName: binding.roleName,
      connectionUriPrinted: false,
    },
    timings,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ result: "SPIKE_C_FAIL", error: error instanceof Error ? error.message : String(error), details: error?.body ?? null, neonProjectId: projectId ?? null, runtimeProjectId: runtimeId ?? null, timings }, null, 2));
  process.exitCode = 1;
} finally {
  if (process.env.SPIKE_DELETE_AFTER_RUN === "true") {
    if (runtimeId) console.log(JSON.stringify({ runtimeCleanup: await deleteRuntime(runtimeId) }, null, 2));
    if (projectId) console.log(JSON.stringify({ databaseCleanup: await deleteDatabase(projectId) }, null, 2));
  }
}
