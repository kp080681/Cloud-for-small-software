import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ensureVercelAuthenticationDisabled,
  VercelPublicAccessState,
  vercelAuthenticationDisabled,
  vercelAuthenticationState,
} from "../src/vercel-public-access.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("Vercel Authentication state is trusted only from provider project responses", () => {
  const currentDisabledShape = {
    id: "prj_public",
    name: "ssc-public-app",
    framework: "nextjs",
  };

  assert.equal(vercelAuthenticationState(currentDisabledShape), "unknown");
  assert.equal(vercelAuthenticationDisabled(currentDisabledShape), false);
  assert.equal(
    vercelAuthenticationState(currentDisabledShape, { trustedVercelProjectResponse: true }),
    "disabled",
  );
  assert.equal(
    vercelAuthenticationDisabled(currentDisabledShape, { trustedVercelProjectResponse: true }),
    true,
  );
});

test("protected Vercel project is made anonymously reachable with ssoProtection null", async () => {
  const updates = [];
  let refetches = 0;
  const result = await ensureVercelAuthenticationDisabled({
    project: {
      id: "prj_protected",
      name: "ssc-protected-app",
      ssoProtection: { deploymentType: "prod_deployment_urls_and_all_previews" },
    },
    trustedVercelProjectResponse: true,
    updateProject: async (projectId, body) => {
      updates.push({ projectId, body });
      return {};
    },
    getProject: async (projectId) => {
      refetches += 1;
      return { id: projectId, name: "ssc-protected-app", ssoProtection: null };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.result, VercelPublicAccessState.DISABLED);
  assert.equal(result.corrected, true);
  assert.equal(refetches, 1);
  assert.deepEqual(updates, [{ projectId: "prj_protected", body: { ssoProtection: null } }]);
});

test("public access mutation is idempotent when Vercel Authentication is already disabled", async () => {
  let updateCalled = false;
  const result = await ensureVercelAuthenticationDisabled({
    project: { id: "prj_public", name: "ssc-public-app", ssoProtection: null },
    trustedVercelProjectResponse: true,
    updateProject: async () => {
      updateCalled = true;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.corrected, false);
  assert.equal(updateCalled, false);
});

test("unknown public access state and unverified update fail closed", async () => {
  const unknown = await ensureVercelAuthenticationDisabled({
    project: { id: "prj_unknown" },
    trustedVercelProjectResponse: true,
    updateProject: async () => {
      throw new Error("must not update unknown state");
    },
  });

  assert.equal(unknown.ok, false);
  assert.equal(unknown.result, VercelPublicAccessState.UNKNOWN);

  const unverified = await ensureVercelAuthenticationDisabled({
    project: {
      id: "prj_still_protected",
      name: "ssc-still-protected",
      ssoProtection: { deploymentType: "all" },
    },
    trustedVercelProjectResponse: true,
    updateProject: async () => ({
      id: "prj_still_protected",
      name: "ssc-still-protected",
      ssoProtection: { deploymentType: "all" },
    }),
  });

  assert.equal(unverified.ok, false);
  assert.equal(unverified.result, VercelPublicAccessState.UNKNOWN);
  assert.equal(unverified.corrected, true);
});

test("health worker ensures anonymous access before workload health request", () => {
  const source = fs.readFileSync(path.join(root, "trigger", "health-check.ts"), "utf8");

  assert.match(source, /assertRemoteProjectMatchesSscApp/);
  assert.match(source, /ensureVercelAuthenticationDisabled/);
  assert.ok(
    source.indexOf("assertRemoteProjectMatchesSscApp") < source.indexOf("ensureVercelAuthenticationDisabled"),
    "project ownership must be verified before public access mutation",
  );
  assert.ok(
    source.indexOf("const publicAccess = await enforceAnonymousProductionAccess") < source.indexOf("HEALTH_CHECK_STARTED"),
    "anonymous access must be ensured before health check state starts",
  );
  assert.ok(
    source.indexOf("const publicAccess = await enforceAnonymousProductionAccess") < source.indexOf("const { response }=await fetchWorkloadUrl"),
    "anonymous access must be ensured before workload HTTP request",
  );
  assert.match(source, /healthCheckRequestInit/);
  assert.doesNotMatch(source, /x-vercel-protection-bypass/i);
});

test("orchestrator still requires final public verification before LIVE", () => {
  const source = fs.readFileSync(path.join(root, "trigger", "orchestrate-deployment.ts"), "utf8");

  assert.ok(
    source.indexOf("ssc-control-plane-health-check") < source.indexOf("ssc-control-plane-configure-public-access"),
    "health must still be followed by final public access verification",
  );
  assert.match(source, /access\?\.publiclyReachable!==true/);
  assert.match(source, /NODE_04_15_LIVE/);
});
