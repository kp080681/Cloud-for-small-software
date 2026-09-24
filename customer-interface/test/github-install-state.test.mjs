import assert from "node:assert/strict";
import test from "node:test";
import { sealGitHubInstallState, unsealGitHubInstallState } from "../src/server/github-install-state.mjs";

const secret = "0123456789abcdef0123456789abcdef";

test("a freshly-sealed install state round-trips correctly", async () => {
  const sealed = await sealGitHubInstallState(
    { state: "nonce-1", customerId: "identity-1", workspaceId: "workspace-1" },
    secret,
  );
  const state = await unsealGitHubInstallState(sealed, secret);
  assert.equal(state.state, "nonce-1");
  assert.equal(state.customerId, "identity-1");
  assert.equal(state.workspaceId, "workspace-1");
});

test("an install state older than 10 minutes is rejected — regression test for the same TTL bug found in session.mjs (Opus 5.5's second pass checked for every use of Iron.defaults, which has no expiry at all, and found this second cookie too)", async () => {
  const realNow = Date.now;
  try {
    const sealed = await sealGitHubInstallState(
      { state: "nonce-1", customerId: "identity-1", workspaceId: "workspace-1" },
      secret,
    );
    Date.now = () => realNow() + 11 * 60 * 1000;
    const state = await unsealGitHubInstallState(sealed, secret);
    assert.equal(state, null);
  } finally {
    Date.now = realNow;
  }
});
