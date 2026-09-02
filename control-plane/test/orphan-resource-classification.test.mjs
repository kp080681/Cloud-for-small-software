import assert from "node:assert/strict";
import test from "node:test";
import {
  OrphanResourceClassification,
  classifyVercelDeploymentResource,
  duplicateSscDeploymentIdentities,
} from "../src/orphan-resource-classification.mjs";

function controlPlane({ deployments = [], builds = [], operations = [] } = {}) {
  return {
    deploymentsById: new Map(deployments.map((item) => [item.id, item])),
    buildsByDeploymentId: new Map(builds.map((item) => [item.deploymentId, item])),
    buildsByProviderDeploymentId: new Map(builds.map((item) => [item.providerDeploymentId, item])),
    operationsByProviderResourceId: new Map(operations.map((item) => [item.providerResourceId, item])),
  };
}

function sscDeployment(overrides = {}) {
  return {
    providerDeploymentId: "dpl_known",
    meta: {
      sscDeploymentId: "dep_1",
      sscSourceCommitSha: "a".repeat(40),
      ...overrides.meta,
    },
    ...overrides,
  };
}

test("correctly bound SSC deployment is known", () => {
  const resource = sscDeployment();
  const result = classifyVercelDeploymentResource(resource, controlPlane({
    deployments: [{ id: "dep_1", sourceCommitSha: "a".repeat(40), status: "LIVE" }],
    builds: [{ deploymentId: "dep_1", providerDeploymentId: "dpl_known" }],
  }));

  assert.equal(result.classification, OrphanResourceClassification.KNOWN);
});

test("matching SSC deployment without local build binding is recoverable", () => {
  const resource = sscDeployment({ providerDeploymentId: "dpl_recoverable" });
  const result = classifyVercelDeploymentResource(resource, controlPlane({
    deployments: [{ id: "dep_1", sourceCommitSha: "a".repeat(40), status: "BUILDING" }],
  }));

  assert.equal(result.classification, OrphanResourceClassification.RECOVERABLE);
});

test("SSC-owned provider deployment whose deployment no longer exists is orphan", () => {
  const result = classifyVercelDeploymentResource(sscDeployment(), controlPlane());

  assert.equal(result.classification, OrphanResourceClassification.ORPHAN);
});

test("duplicate SSC provider resources for one deployment identity are ambiguous", () => {
  const first = sscDeployment({ providerDeploymentId: "dpl_1" });
  const second = sscDeployment({ providerDeploymentId: "dpl_2" });
  const ambiguousIdentities = duplicateSscDeploymentIdentities([first, second]);

  const result = classifyVercelDeploymentResource(first, controlPlane({
    deployments: [{ id: "dep_1", sourceCommitSha: "a".repeat(40), status: "BUILDING" }],
  }), { ambiguousIdentities });

  assert.equal(result.classification, OrphanResourceClassification.AMBIGUOUS);
});

test("provider deployment without SSC metadata is ignored as foreign", () => {
  const result = classifyVercelDeploymentResource({ providerDeploymentId: "dpl_foreign", meta: {} }, controlPlane());

  assert.equal(result.classification, OrphanResourceClassification.FOREIGN_IGNORE);
});

test("terminal historical deployment with legitimate provider history is not orphan", () => {
  const resource = sscDeployment({ providerDeploymentId: "dpl_failed_history" });
  const result = classifyVercelDeploymentResource(resource, controlPlane({
    deployments: [{ id: "dep_1", sourceCommitSha: "a".repeat(40), status: "FAILED" }],
    builds: [{ deploymentId: "dep_1", providerDeploymentId: "dpl_failed_history" }],
  }));

  assert.equal(result.classification, OrphanResourceClassification.KNOWN);
});
