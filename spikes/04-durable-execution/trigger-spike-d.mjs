import "dotenv/config";
import { tasks } from "@trigger.dev/sdk";
import { createDeployment, ensureSchema } from "./state.mjs";

const sha = process.env.SPIKE_GIT_SHA;
if (!sha) throw new Error("SPIKE_GIT_SHA is required");
if (!process.env.TRIGGER_SECRET_KEY) throw new Error("TRIGGER_SECRET_KEY is required");

await ensureSchema();

const deploymentKey = `spike-d-${Date.now()}`;
const runtimeName = `ssc-spike-d-${Date.now()}`;
await createDeployment({
  deploymentKey,
  repository: "kp080681/Cloud-for-small-software",
  gitSha: sha,
  runtimeName,
});

const handle = await tasks.trigger("ssc-spike-d-durable-deploy", { deploymentKey });

console.log(JSON.stringify({
  result: "SPIKE_D_QUEUED",
  deploymentKey,
  triggerRunId: handle.id,
  instruction: "You may close this PowerShell process now. Trigger.dev owns execution; PostgreSQL owns canonical state.",
}, null, 2));
