import { task } from "@trigger.dev/sdk";
import { ensureRuntime, getCandidateUrl, startDeployment, waitForDeployment } from "../../01-runtime-only/runtime-adapter/vercel-runtime.mjs";
import { beginAttempt, claimForcedFailure, getDeployment, markFailed, markLive, recordProviderDeployment, recordRuntime } from "../state.mjs";

export const durableDeploy = task({
  id: "ssc-spike-d-durable-deploy",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 10000,
    factor: 2,
    randomize: false,
  },
  run: async (payload: { deploymentKey: string }) => {
    const state = await beginAttempt(payload.deploymentKey);
    const [owner, repo] = state.repository.split("/");
    const rootDirectory = "spikes/01-runtime-only/test-app";

    try {
      const runtime = await ensureRuntime({
        name: state.runtime_name,
        repository: state.repository,
        rootDirectory,
      });
      await recordRuntime(payload.deploymentKey, runtime.resource.id);

      // Deliberately fail exactly once AFTER provider runtime creation. The next
      // Trigger.dev attempt must recover from Postgres and reconcile this same
      // Vercel project rather than create a duplicate.
      if (await claimForcedFailure(payload.deploymentKey)) {
        throw new Error("SPIKE_D_FORCED_RETRY_AFTER_RUNTIME_CREATION");
      }

      const latest = await getDeployment(payload.deploymentKey);
      if (!latest) throw new Error("Canonical deployment state disappeared");
      if (latest.runtime_project_id !== runtime.resource.id) {
        throw new Error("Runtime reconciliation produced a different provider resource");
      }

      const created = await startDeployment({
        name: state.runtime_name,
        projectId: runtime.resource.id,
        owner,
        repo,
        ref: "main",
        sha: state.git_sha,
        rootDirectory,
      });
      await recordProviderDeployment(payload.deploymentKey, created.id);

      const ready = await waitForDeployment(created.id);
      const url = getCandidateUrl(ready);
      const finalState = await markLive(payload.deploymentKey, url);

      return {
        result: "SPIKE_D_TASK_PASS",
        deploymentKey: payload.deploymentKey,
        attempts: finalState.attempts,
        runtimeProjectId: finalState.runtime_project_id,
        providerDeploymentId: finalState.provider_deployment_id,
        url: finalState.live_url,
      };
    } catch (error) {
      await markFailed(payload.deploymentKey, error instanceof Error ? error.message : String(error));
      throw error;
    }
  },
});
