import assert from "node:assert/strict";
import test from "node:test";
import {
  deploymentStageIndex,
  deploymentStageOrder,
  deploymentStageTrackerLabel,
  friendlyErrorMessage,
  readinessLabel,
  redeployFailureMessage,
  redeploySuccessMessage,
  retrySuccessMessage,
  stageLabelForStatus,
} from "../src/shared/deployment-ui-state.mjs";

test("friendlyErrorMessage maps known backend codes to plain language", () => {
  assert.match(friendlyErrorMessage("WORKSPACE_RATE_LIMIT_REACHED"), /too fast/);
  assert.match(friendlyErrorMessage("APP_PAUSED"), /paused/);
});

test("friendlyErrorMessage never surfaces a raw code for an unmapped or missing code", () => {
  assert.equal(friendlyErrorMessage("SOME_FUTURE_CODE_NOT_YET_MAPPED"), "Something went wrong. Please try again.");
  assert.equal(friendlyErrorMessage(undefined), "Something went wrong. Please try again.");
  assert.equal(friendlyErrorMessage(null, "Custom fallback."), "Custom fallback.");
});

test("stageLabelForStatus never returns a raw backend status word", () => {
  const statuses = ["ANALYZING", "PROVISIONING", "BUILDING", "DEPLOYING", "HEALTH_CHECKING", "LIVE", "FAILED", "DELETING", "DELETED"];
  for (const status of statuses) {
    const label = stageLabelForStatus(status);
    assert.notEqual(label, status);
    assert.equal(typeof label, "string");
    assert.ok(label.length > 0);
  }
});

test("stageLabelForStatus falls back cleanly for an unknown status", () => {
  assert.equal(stageLabelForStatus("SOMETHING_NEW"), "Not started yet");
  assert.equal(stageLabelForStatus(undefined), "Not started yet");
});

test("redeployFailureMessage now actually uses the code it's passed, not a generic string regardless of cause", () => {
  assert.match(redeployFailureMessage("WORKSPACE_RATE_LIMIT_REACHED"), /too fast/);
  assert.match(redeployFailureMessage("APP_PAUSED"), /paused/);
  assert.match(redeployFailureMessage("SOMETHING_UNMAPPED"), /Redeployment could not be started/);
});

test("readinessLabel never returns a raw backend readiness word, discovered live in production when it was", () => {
  assert.equal(readinessLabel("READY_TO_DEPLOY"), "Ready to deploy");
  assert.equal(readinessLabel("CONFIGURATION_REQUIRED"), "Waiting on configuration");
  assert.equal(readinessLabel("BLOCKED"), "Blocked — see below");
  for (const value of ["READY_TO_DEPLOY", "CONFIGURATION_REQUIRED", "BLOCKED"]) {
    assert.notEqual(readinessLabel(value), value);
  }
});

test("readinessLabel falls back cleanly for an unknown or missing value", () => {
  assert.equal(readinessLabel("SOMETHING_NEW"), "Configuration status pending");
  assert.equal(readinessLabel(undefined), "Configuration status pending");
});

test("friendlyErrorMessage covers the analysis errorCode set too, not just deployment/config codes — found live showing the raw code as \"Unsupported: PACKAGE_JSON_NOT_FOUND\"", () => {
  assert.match(friendlyErrorMessage("PACKAGE_JSON_NOT_FOUND"), /package\.json/);
  assert.match(friendlyErrorMessage("UNSUPPORTED_PROJECT"), /not a supported/);
  assert.match(friendlyErrorMessage("APP_SLUG_CONFLICT"), /already used/);
});

test("deploymentStageOrder lists the real pipeline in the order it actually runs, with LIVE last", () => {
  const order = deploymentStageOrder();
  assert.deepEqual(order, ["ANALYZING", "PROVISIONING", "BUILDING", "DEPLOYING", "HEALTH_CHECKING", "LIVE"]);
});

test("deploymentStageIndex finds every pipeline stage in order and returns -1 for terminal/branch states the tracker must not guess at", () => {
  const order = deploymentStageOrder();
  order.forEach((status, index) => {
    assert.equal(deploymentStageIndex(status), index);
  });
  // FAILED, DELETING, DELETED are not positions in the linear pipeline — the
  // UI's step tracker renders nothing for these rather than inventing a
  // guessed position, so this must stay -1 and never accidentally match a
  // real index.
  for (const terminal of ["FAILED", "DELETING", "DELETED", "SOMETHING_UNKNOWN", undefined]) {
    assert.equal(deploymentStageIndex(terminal), -1);
  }
});

test("deploymentStageTrackerLabel gives a short plain-language caption for every pipeline stage, distinct from the longer stageLabelForStatus headline", () => {
  for (const status of deploymentStageOrder()) {
    const trackerLabel = deploymentStageTrackerLabel(status);
    assert.equal(typeof trackerLabel, "string");
    assert.ok(trackerLabel.length > 0);
    assert.notEqual(trackerLabel, status);
  }
});

test("retrySuccessMessage and redeploySuccessMessage stay plain language across every branch", () => {
  const jargonPattern = /ANALYZING|PROVISIONING|BUILDING|DEPLOYING|HEALTH_CHECKING/;
  assert.doesNotMatch(retrySuccessMessage({ retry: { limitReached: true } }), jargonPattern);
  assert.doesNotMatch(retrySuccessMessage({ status: "LIVE" }), jargonPattern);
  assert.doesNotMatch(retrySuccessMessage({ retry: { created: true } }), jargonPattern);
  assert.doesNotMatch(retrySuccessMessage({ retry: { alreadyStarted: true } }), jargonPattern);
  assert.doesNotMatch(redeploySuccessMessage({ redeploy: { created: true } }), jargonPattern);
  assert.doesNotMatch(redeploySuccessMessage({ redeploy: { reusedActive: true } }), jargonPattern);
});
