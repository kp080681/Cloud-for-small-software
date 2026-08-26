import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "REPLACE_WITH_TRIGGER_PROJECT_REF",
  dirs: ["./trigger"],
  maxDuration: 600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 2000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: false,
    },
  },
});
