import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WORKSPACE_RESOURCE_POLICY as dashboard } from "../src/shared/control-plane/workspace-resource-policy.mjs";
import { DEFAULT_WORKSPACE_RESOURCE_POLICY as engine } from "../../control-plane/src/workspace-resource-policy.mjs";

// Both sides seed a workspace's limits with INSERT ... ON CONFLICT DO NOTHING,
// so whichever touches a workspace first fixes its stored limits. If these
// two defaults ever differ again, workspaces silently get different caps
// depending on which side created them (this happened: 3 vs 25 apps).
test("dashboard and engine seed identical default workspace limits", () => {
  assert.deepEqual({ ...dashboard }, { ...engine });
});
