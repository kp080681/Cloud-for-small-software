import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // Not a secret -- Trigger.dev project refs are plain identifiers, safe to
  // commit (see their own docs/dashboard, which display it in the clear).
  // Still override-able via TRIGGER_PROJECT_REF for anyone deploying a
  // separate project (e.g. a fork), but CI and local deploys no longer
  // depend on that env var being set correctly somewhere unversioned.
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_eylhpryaswabdrlkdkhp",
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
