import "dotenv/config";
import { getDeployment } from "./state.mjs";

const deploymentKey = process.argv[2];
if (!deploymentKey) throw new Error("Usage: node monitor-spike-d.mjs <deploymentKey>");

const state = await getDeployment(deploymentKey);
if (!state) throw new Error(`No deployment found for ${deploymentKey}`);

console.log(JSON.stringify({
  result: state.status === "LIVE" && state.attempts >= 2 ? "SPIKE_D_PASS" : "SPIKE_D_PENDING",
  deploymentKey: state.deployment_key,
  status: state.status,
  attempts: state.attempts,
  forcedFailureRecorded: state.forced_failure_recorded,
  runtimeProjectId: state.runtime_project_id,
  providerDeploymentId: state.provider_deployment_id,
  url: state.live_url,
  lastError: state.last_error,
}, null, 2));
