import { sscDeploymentMeta } from "./vercel-deployment-recovery.mjs";

export const RECOVERY_TEST_APP_ID = "6bc015df-ccb1-4151-982e-3ea24e45c54b";
export const RECOVERY_TEST_PROVIDER_PROJECT_ID = "prj_vVfWE0VMyYvABEUkQFa3X8oEYOhj";
export const NODE_04_19_ORPHAN_FIXTURE_KIND = "node-04-19-disposable-orphan";

export function assertRecoveryTestRuntime({ appId, providerProjectId }) {
  if (appId !== RECOVERY_TEST_APP_ID || providerProjectId !== RECOVERY_TEST_PROVIDER_PROJECT_ID) {
    throw new Error(
      `Refusing to create orphan fixture outside disposable recovery-test runtime: app=${appId ?? "missing"} project=${providerProjectId ?? "missing"}`,
    );
  }
}

export function node0419OrphanFixtureMeta({
  deploymentId,
  sourceCommitSha,
  manifestSha256,
  appId = RECOVERY_TEST_APP_ID,
  providerProjectId = RECOVERY_TEST_PROVIDER_PROJECT_ID,
}) {
  assertRecoveryTestRuntime({ appId, providerProjectId });
  return {
    ...sscDeploymentMeta({ deploymentId, sourceCommitSha, manifestSha256 }),
    sscFixture: NODE_04_19_ORPHAN_FIXTURE_KIND,
    sscFixtureNode: "04.19",
    sscFixturePurpose: "controlled orphan-resource fault injection",
    sscFixtureAppId: appId,
    sscFixtureProviderProjectId: providerProjectId,
  };
}

export function isNode0419OrphanFixtureResource(resource) {
  const meta = resource?.meta && typeof resource.meta === "object" ? resource.meta : {};
  return meta.sscFixture === NODE_04_19_ORPHAN_FIXTURE_KIND
    && meta.sscFixtureAppId === RECOVERY_TEST_APP_ID
    && meta.sscFixtureProviderProjectId === RECOVERY_TEST_PROVIDER_PROJECT_ID;
}
