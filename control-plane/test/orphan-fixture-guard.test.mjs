import assert from "node:assert/strict";
import test from "node:test";
import {
  NODE_04_19_ORPHAN_FIXTURE_KIND,
  RECOVERY_TEST_APP_ID,
  RECOVERY_TEST_PROVIDER_PROJECT_ID,
  assertRecoveryTestRuntime,
  isNode0419OrphanFixtureResource,
  node0419OrphanFixtureMeta,
} from "../src/orphan-fixture-guard.mjs";

test("recovery-test guard accepts only the approved app and Vercel project", () => {
  assert.doesNotThrow(() => assertRecoveryTestRuntime({
    appId: RECOVERY_TEST_APP_ID,
    providerProjectId: RECOVERY_TEST_PROVIDER_PROJECT_ID,
  }));
});

test("recovery-test guard rejects any other app id", () => {
  assert.throws(
    () => assertRecoveryTestRuntime({
      appId: "00000000-0000-0000-0000-000000000000",
      providerProjectId: RECOVERY_TEST_PROVIDER_PROJECT_ID,
    }),
    /Refusing to create orphan fixture outside disposable recovery-test runtime/,
  );
});

test("recovery-test guard rejects any other provider project id", () => {
  assert.throws(
    () => assertRecoveryTestRuntime({
      appId: RECOVERY_TEST_APP_ID,
      providerProjectId: "prj_vantage_not_allowed",
    }),
    /Refusing to create orphan fixture outside disposable recovery-test runtime/,
  );
});

test("fixture metadata remains positively SSC-attributable and marked disposable", () => {
  const meta = node0419OrphanFixtureMeta({
    deploymentId: "11111111-1111-4111-8111-111111111111",
    sourceCommitSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
  });

  assert.equal(meta.sscDeploymentId, "11111111-1111-4111-8111-111111111111");
  assert.equal(meta.sscSourceCommitSha, "a".repeat(40));
  assert.equal(meta.sscManifestSha256, "b".repeat(64));
  assert.equal(meta.sscFixture, NODE_04_19_ORPHAN_FIXTURE_KIND);
  assert.equal(meta.sscFixtureNode, "04.19");
  assert.equal(meta.sscFixtureAppId, RECOVERY_TEST_APP_ID);
  assert.equal(meta.sscFixtureProviderProjectId, RECOVERY_TEST_PROVIDER_PROJECT_ID);
  assert.equal(isNode0419OrphanFixtureResource({ meta }), true);
});

test("fixture marker does not match foreign or incomplete resources", () => {
  assert.equal(isNode0419OrphanFixtureResource({ meta: {} }), false);
  assert.equal(isNode0419OrphanFixtureResource({
    meta: {
      sscFixture: NODE_04_19_ORPHAN_FIXTURE_KIND,
      sscFixtureAppId: RECOVERY_TEST_APP_ID,
      sscFixtureProviderProjectId: "prj_wrong",
    },
  }), false);
});
