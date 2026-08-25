import {
  createAutomationBypass,
  deleteRuntime,
  ensureRuntime,
  setEnvironment,
  startDeployment,
  waitForDeploymentTerminal,
} from "../01-runtime-only/runtime-adapter/vercel-runtime.mjs";

const repository = process.env.SPIKE_GITHUB_REPOSITORY ?? "kp080681/Cloud-for-small-software";
const [owner, repo] = repository.split("/");
const ref = process.env.SPIKE_GIT_REF ?? "main";
const sha = process.env.SPIKE_GIT_SHA;
const rootDirectory = "spikes/01-runtime-only/test-app";
const marker = `spike-b-${Date.now()}`;
const projectName = process.env.SPIKE_B_PROJECT_NAME ?? `ssc-spike-b-${Date.now()}`;

if (!owner || !repo) throw new Error("SPIKE_GITHUB_REPOSITORY must be owner/repo");
if (!sha) throw new Error("SPIKE_GIT_SHA is required");

let projectId;
const checks = {};

try {
  const first = await ensureRuntime({ name: projectName, repository, rootDirectory });
  projectId = first.resource.id;
  checks.firstRuntime = { created: first.created, reconciled: first.reconciled, projectId };

  // Repeating the same logical create must resolve to the same provider resource.
  const second = await ensureRuntime({ name: projectName, repository, rootDirectory });
  checks.duplicateRuntime = {
    sameProject: second.resource.id === projectId,
    created: second.created,
    reconciled: second.reconciled,
    projectId: second.resource.id,
  };

  if (!checks.duplicateRuntime.sameProject || second.created) {
    throw new Error("Duplicate runtime reconciliation failed");
  }

  const protectionBypass = await createAutomationBypass(projectId);
  await setEnvironment({ projectId, key: "APP_BUILD_MARKER", value: marker });

  // Deliberately invalid build command. This deployment MUST fail and MUST NOT be
  // interpreted as LIVE merely because Vercel returned a deployment resource.
  const failedCandidate = await startDeployment({
    name: projectName,
    projectId,
    owner,
    repo,
    ref,
    sha,
    rootDirectory,
    buildCommand: "node -e \"process.exit(73)\"",
  });

  const terminal = await waitForDeploymentTerminal(failedCandidate.id);
  checks.controlledBuildFailure = {
    deploymentId: failedCandidate.id,
    terminalState: terminal.state,
    correctlyRejected: terminal.state === "ERROR",
    markedLive: false,
  };

  if (terminal.state !== "ERROR") {
    throw new Error(`Controlled build failure unexpectedly ended as ${terminal.state}`);
  }

  // The bypass secret is intentionally never included in output.
  checks.secretOutput = { protectionBypassPrinted: false };

  const firstDelete = await deleteRuntime(projectId);
  const secondDelete = await deleteRuntime(projectId);
  checks.cleanup = { firstDelete, secondDelete };

  if (!firstDelete.deleted || !secondDelete.deleted || !secondDelete.alreadyAbsent) {
    throw new Error("Repeated cleanup was not idempotent");
  }

  console.log(JSON.stringify({
    result: "SPIKE_B_PASS",
    repository,
    ref,
    sha,
    checks,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    result: "SPIKE_B_FAIL",
    projectId: projectId ?? null,
    error: error instanceof Error ? error.message : String(error),
    details: error?.body ?? null,
    checks,
  }, null, 2));

  if (projectId) {
    try {
      const cleanup = await deleteRuntime(projectId);
      console.error(JSON.stringify({ emergencyCleanup: cleanup, projectId }, null, 2));
    } catch (cleanupError) {
      console.error(JSON.stringify({
        emergencyCleanup: "FAILED",
        projectId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      }, null, 2));
    }
  }

  process.exitCode = 1;
}
