import assert from "node:assert/strict";
import test from "node:test";
import {
  friendlyErrorMessage,
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

test("retrySuccessMessage and redeploySuccessMessage stay plain language across every branch", () => {
  const jargonPattern = /ANALYZING|PROVISIONING|BUILDING|DEPLOYING|HEALTH_CHECKING/;
  assert.doesNotMatch(retrySuccessMessage({ retry: { limitReached: true } }), jargonPattern);
  assert.doesNotMatch(retrySuccessMessage({ status: "LIVE" }), jargonPattern);
  assert.doesNotMatch(retrySuccessMessage({ retry: { created: true } }), jargonPattern);
  assert.doesNotMatch(retrySuccessMessage({ retry: { alreadyStarted: true } }), jargonPattern);
  assert.doesNotMatch(redeploySuccessMessage({ redeploy: { created: true } }), jargonPattern);
  assert.doesNotMatch(redeploySuccessMessage({ redeploy: { reusedActive: true } }), jargonPattern);
});
