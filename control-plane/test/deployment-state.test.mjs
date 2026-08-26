import assert from "node:assert/strict";
import test from "node:test";
import {
  DeploymentStatus,
  assertTransition,
  canTransition,
  isTerminal,
  nextStatusForSuccessfulStep,
} from "../src/deployment-state.mjs";

test("normal deployment path is legal", () => {
  const path = [
    "DRAFT",
    "READY",
    "QUEUED",
    "ANALYZING",
    "PROVISIONING",
    "BUILDING",
    "DEPLOYING",
    "HEALTH_CHECKING",
    "LIVE",
  ];

  for (let i = 0; i < path.length - 1; i += 1) {
    assert.equal(canTransition(path[i], path[i + 1]), true);
  }
});

test("database provisioning may be skipped", () => {
  assert.equal(
    nextStatusForSuccessfulStep(DeploymentStatus.ANALYZING, { databaseRequired: false }),
    DeploymentStatus.BUILDING,
  );
});

test("database provisioning is selected when required", () => {
  assert.equal(
    nextStatusForSuccessfulStep(DeploymentStatus.ANALYZING, { databaseRequired: true }),
    DeploymentStatus.PROVISIONING,
  );
});

test("failed deployment may be retried by requeueing", () => {
  assert.equal(canTransition(DeploymentStatus.FAILED, DeploymentStatus.QUEUED), true);
});

test("illegal backward transition is rejected", () => {
  assert.throws(
    () => assertTransition(DeploymentStatus.BUILDING, DeploymentStatus.ANALYZING),
    /Illegal deployment transition/,
  );
});

test("live and deleted are terminal successful lifecycle states", () => {
  assert.equal(isTerminal(DeploymentStatus.LIVE), true);
  assert.equal(isTerminal(DeploymentStatus.DELETED), true);
  assert.equal(isTerminal(DeploymentStatus.FAILED), false);
});
