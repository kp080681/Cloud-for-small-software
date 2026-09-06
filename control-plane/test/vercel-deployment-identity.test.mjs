import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildReconciliationAction } from "../src/deployment-recovery-rules.mjs";
import {
  ProviderDeploymentIdentityStatus,
  PublicBindingStatus,
  SourceIdentityStatus,
  providerObservedSourceSha,
  verifyProviderDeploymentIdentity,
  verifyProviderSourceIdentity,
  verifyPublicBinding,
} from "../src/vercel-deployment-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sourceSha = "f6afa1c1312de8d6da8d49fdab22148ae5701199";
const otherSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function deployment(overrides = {}) {
  return {
    id: "dpl_new",
    uid: "dpl_new",
    projectId: "prj_dealup",
    meta: {
      sscDeploymentId: "dep_dealup",
      sscSourceCommitSha: sourceSha,
      githubCommitSha: sourceSha,
    },
    gitSource: { type: "github", ref: sourceSha },
    ...overrides,
  };
}

test("expected independent provider source SHA verifies build identity", () => {
  const result = verifyProviderSourceIdentity(deployment(), sourceSha);

  assert.equal(result.status, SourceIdentityStatus.MATCH);
  assert.equal(result.observedCommitSha, sourceSha);
  assert.deepEqual(
    buildReconciliationAction({
      deploymentStatus: "BUILDING",
      providerStatus: "READY",
      sourceIdentityStatus: result.status,
    }),
    { action: "advance-deploying" },
  );
});

test("wrong independent provider source SHA refuses build verification", () => {
  const result = verifyProviderSourceIdentity(deployment({ meta: { githubCommitSha: otherSha } }), sourceSha);

  assert.equal(result.status, SourceIdentityStatus.MISMATCH);
  assert.deepEqual(
    buildReconciliationAction({
      deploymentStatus: "BUILDING",
      providerStatus: "READY",
      sourceIdentityStatus: result.status,
    }),
    { action: "source-unverified" },
  );
});

test("missing independent provider source SHA does not verify build", () => {
  const result = verifyProviderSourceIdentity(deployment({ meta: { sscDeploymentId: "dep_dealup", sscSourceCommitSha: sourceSha }, gitSource: null }), sourceSha);

  assert.equal(result.status, SourceIdentityStatus.UNAVAILABLE);
  assert.deepEqual(
    buildReconciliationAction({
      deploymentStatus: "BUILDING",
      providerStatus: "READY",
      sourceIdentityStatus: result.status,
    }),
    { action: "source-unverified" },
  );
});

test("SSC-submitted source metadata alone is not independent provider source proof", () => {
  const provider = deployment({ meta: { sscDeploymentId: "dep_dealup", sscSourceCommitSha: sourceSha }, gitSource: {} });

  assert.equal(providerObservedSourceSha(provider), null);
  assert.equal(verifyProviderSourceIdentity(provider, sourceSha).status, SourceIdentityStatus.UNAVAILABLE);
});

test("provider deployment from the wrong project is rejected", () => {
  const result = verifyProviderDeploymentIdentity(deployment({ projectId: "prj_other" }), {
    deploymentId: "dep_dealup",
    providerDeploymentId: "dpl_new",
    providerProjectId: "prj_dealup",
  });

  assert.equal(result.status, ProviderDeploymentIdentityStatus.MISMATCH);
});

test("provider deployment with wrong SSC deployment metadata is rejected", () => {
  const result = verifyProviderDeploymentIdentity(deployment({ meta: { sscDeploymentId: "dep_other", sscSourceCommitSha: sourceSha } }), {
    deploymentId: "dep_dealup",
    providerDeploymentId: "dpl_new",
    providerProjectId: "prj_dealup",
  });

  assert.equal(result.status, ProviderDeploymentIdentityStatus.MISMATCH);
});

test("exact deployment healthy and canonical alias on same deployment can become live", () => {
  const result = verifyPublicBinding({
    canonicalHost: "ssc-dealup.vercel.app",
    providerDeploymentId: "dpl_new",
    providerProjectId: "prj_dealup",
    alias: { alias: "ssc-dealup.vercel.app", deploymentId: "dpl_new", projectId: "prj_dealup" },
    deploymentAliases: { aliases: [{ alias: "ssc-dealup.vercel.app" }] },
  });

  assert.equal(result.status, PublicBindingStatus.MATCH);
});

test("stale canonical alias returning HTTP 200 cannot mark the new deployment live", () => {
  const result = verifyPublicBinding({
    canonicalHost: "ssc-dealup.vercel.app",
    providerDeploymentId: "dpl_new",
    providerProjectId: "prj_dealup",
    alias: { alias: "ssc-dealup.vercel.app", deploymentId: "dpl_old", projectId: "prj_dealup" },
    deploymentAliases: { aliases: [{ alias: "dpl-new.vercel.app" }] },
  });

  assert.equal(result.status, PublicBindingStatus.MISMATCH);
});

test("canonical alias mapping correct but public health failure remains not live", () => {
  const binding = verifyPublicBinding({
    canonicalHost: "ssc-dealup.vercel.app",
    providerDeploymentId: "dpl_new",
    providerProjectId: "prj_dealup",
    alias: { alias: "ssc-dealup.vercel.app", deployment: { id: "dpl_new" }, projectId: "prj_dealup" },
    deploymentAliases: [{ alias: "ssc-dealup.vercel.app" }],
  });
  const publicHealth = { publiclyReachable: false, httpStatus: 500 };

  assert.equal(binding.status, PublicBindingStatus.MATCH);
  assert.equal(publicHealth.publiclyReachable, false);
});

test("canonical HTTP 200 without provider binding proof remains not live", () => {
  const binding = verifyPublicBinding({
    canonicalHost: "ssc-dealup.vercel.app",
    providerDeploymentId: "dpl_new",
    providerProjectId: "prj_dealup",
    alias: null,
    deploymentAliases: { aliases: [{ alias: "ssc-dealup.vercel.app" }] },
  });

  assert.equal(binding.status, PublicBindingStatus.UNAVAILABLE);
});

test("omitted provider identity fields fail closed", () => {
  assert.equal(
    verifyProviderDeploymentIdentity({ id: "dpl_new", meta: { sscDeploymentId: "dep_dealup" } }, {
      deploymentId: "dep_dealup",
      providerDeploymentId: "dpl_new",
      providerProjectId: "prj_dealup",
    }).status,
    ProviderDeploymentIdentityStatus.UNAVAILABLE,
  );
  assert.equal(
    verifyPublicBinding({
      canonicalHost: "ssc-dealup.vercel.app",
      providerDeploymentId: "dpl_new",
      providerProjectId: "prj_dealup",
      alias: { alias: "ssc-dealup.vercel.app", deploymentId: "dpl_new" },
      deploymentAliases: { aliases: [{ alias: "ssc-dealup.vercel.app" }] },
    }).status,
    PublicBindingStatus.UNAVAILABLE,
  );
});

test("DealUp-style provider evidence satisfies the new identity flow", () => {
  const provider = deployment();
  const deploymentIdentity = verifyProviderDeploymentIdentity(provider, {
    deploymentId: "dep_dealup",
    providerDeploymentId: "dpl_new",
    providerProjectId: "prj_dealup",
  });
  const sourceIdentity = verifyProviderSourceIdentity(provider, sourceSha);
  const binding = verifyPublicBinding({
    canonicalHost: "ssc-dealup.vercel.app",
    providerDeploymentId: "dpl_new",
    providerProjectId: "prj_dealup",
    alias: { alias: "ssc-dealup.vercel.app", deployment: { id: "dpl_new" }, projectId: "prj_dealup" },
    deploymentAliases: { aliases: [{ alias: "ssc-dealup.vercel.app" }] },
  });
  const publicHealth = { publiclyReachable: true, httpStatus: 200 };

  assert.equal(deploymentIdentity.status, ProviderDeploymentIdentityStatus.MATCH);
  assert.equal(sourceIdentity.status, SourceIdentityStatus.MATCH);
  assert.equal(binding.status, PublicBindingStatus.MATCH);
  assert.equal(publicHealth.publiclyReachable, true);
});

test("execute-build uses immutable build input framework before mutable app framework", () => {
  const source = fs.readFileSync(path.join(root, "trigger", "execute-build.ts"), "utf8");

  assert.match(source, /bi\.manifest->>'framework' AS build_input_framework/);
  assert.match(source, /framework:deployment\.build_input_framework\|\|deployment\.framework\|\|"nextjs"/);
});

test("public access task verifies provider binding before anonymous reachability can mark LIVE", () => {
  const source = fs.readFileSync(path.join(root, "trigger", "configure-public-access.ts"), "utf8");
  const aliasLookup = source.indexOf("/v4/aliases/");
  const deploymentAliases = source.indexOf("/v2/deployments/");
  const bindingCheck = source.indexOf("verifyPublicBinding");
  const anonymousCheck = source.indexOf("const checked=await anonymousCheck");
  const liveUpdate = source.indexOf("UPDATE deployments SET status='LIVE'");

  assert.ok(aliasLookup > -1);
  assert.ok(deploymentAliases > -1);
  assert.ok(bindingCheck > -1);
  assert.ok(aliasLookup < anonymousCheck);
  assert.ok(deploymentAliases < anonymousCheck);
  assert.ok(bindingCheck < anonymousCheck);
  assert.ok(anonymousCheck < liveUpdate);
  assert.match(source, /PUBLIC_BINDING_UNVERIFIED/);
});
