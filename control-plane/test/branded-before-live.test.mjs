import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "trigger", "configure-public-access.ts"), "utf8");

// The dashboard stops polling the moment a deployment reads LIVE, so the
// branded URL has to be decided before that write, not after it.
test("branded URL is resolved before the deployment is marked LIVE", () => {
  const resolveCall = source.indexOf("await resolveBrandedUrlBeforeLive({");
  const liveWrite = source.indexOf("UPDATE deployments SET status='LIVE'");
  assert.ok(resolveCall > -1 && liveWrite > -1);
  assert.ok(resolveCall < liveWrite, "branded resolution must happen before the LIVE write");
  assert.match(source, /const liveUrl=early\.url\?\?checkUrl;/);
  assert.match(source, /status='LIVE',live_url=\$1[^`]*`,\[liveUrl,payload\.deploymentId\]/);
});

test("the verified provider URL is still recorded for fallback restores", () => {
  // restoreProviderUrlIfBranded reads checkUrl from PUBLIC_ACCESS_VERIFIED
  assert.match(source, /'PUBLIC_ACCESS_VERIFIED'[^;]*JSON\.stringify\(\{checkUrl,/);
});
