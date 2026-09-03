import { tasks } from "@trigger.dev/sdk";

if (!process.env.TRIGGER_SECRET_KEY) throw new Error("Missing required environment variable: TRIGGER_SECRET_KEY");

const deploymentId = process.argv[2];
if (!deploymentId) {
  throw new Error("Usage: node scripts/run-deployment-timeline.mjs <deployment-id>");
}

const handle = await tasks.trigger("ssc-control-plane-get-deployment-timeline", { deploymentId });

console.log(JSON.stringify({
  result: "NODE_04_21_DEPLOYMENT_TIMELINE_TRIGGERED",
  deploymentId,
  triggerRunId: handle.id,
  destructiveOperationExecuted: false,
  providerResourcesMutated: false,
  rawBuildLogsReturned: false,
  providerResponseBodiesReturned: false,
  tokensPrinted: false,
  secretsPrinted: false,
}, null, 2));
