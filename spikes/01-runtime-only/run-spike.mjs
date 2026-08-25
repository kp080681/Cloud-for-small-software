import {
  createRuntime,
  deleteRuntime,
  getCandidateUrl,
  setEnvironment,
  startDeployment,
  verifyHealth,
  waitForDeployment,
} from "./runtime-adapter/vercel-runtime.mjs";

const repository = process.env.SPIKE_GITHUB_REPOSITORY ?? "kp080681/Cloud-for-small-software";
const [owner, repo] = repository.split("/");
const ref = process.env.SPIKE_GIT_REF ?? "main";
const sha = process.env.SPIKE_GIT_SHA;
const rootDirectory = "spikes/01-runtime-only/test-app";
const marker = process.env.APP_BUILD_MARKER ?? `spike-a-${Date.now()}`;
const projectName = process.env.SPIKE_PROJECT_NAME ?? `ssc-spike-a-${Date.now()}`;

if (!owner || !repo) throw new Error("SPIKE_GITHUB_REPOSITORY must be owner/repo");
if (!sha) throw new Error("SPIKE_GIT_SHA is required. Spike A must deploy a pinned commit.");

const timings = {};
let projectId;

function begin(name) {
  timings[name] = { startedAt: Date.now() };
}

function end(name) {
  timings[name].finishedAt = Date.now();
  timings[name].durationMs = timings[name].finishedAt - timings[name].startedAt;
}

try {
  begin("runtimeProvisioning");
  const project = await createRuntime({ name: projectName, repository, rootDirectory });
  projectId = project.id;
  end("runtimeProvisioning");

  begin("configuration");
  await setEnvironment({ projectId, key: "APP_BUILD_MARKER", value: marker });
  end("configuration");

  begin("deployment");
  const created = await startDeployment({
    name: projectName,
    projectId,
    owner,
    repo,
    ref,
    sha,
    rootDirectory,
  });
  const ready = await waitForDeployment(created.id);
  end("deployment");

  const baseUrl = getCandidateUrl(ready);

  begin("healthVerification");
  const health = await verifyHealth({ baseUrl, expectedMarker: marker });
  end("healthVerification");

  console.log(JSON.stringify({
    result: "LIVE",
    repository,
    ref,
    sha,
    projectId,
    deploymentId: ready.id,
    url: baseUrl,
    health,
    timings,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    result: "FAILED",
    projectId: projectId ?? null,
    error: error instanceof Error ? error.message : String(error),
    details: error?.body ?? null,
    timings,
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (process.env.SPIKE_DELETE_AFTER_RUN === "true" && projectId) {
    const deletion = await deleteRuntime(projectId);
    console.log(JSON.stringify({ cleanup: deletion, projectId }, null, 2));
  }
}
