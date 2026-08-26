import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "REPLACE_WITH_TRIGGER_PROJECT_REF",
  dirs: ["./trigger"],
  maxDuration: 300,
});
