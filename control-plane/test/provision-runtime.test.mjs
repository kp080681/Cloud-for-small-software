import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "..");

test("provision-runtime's Vercel request function has a real timeout, not an unbounded fetch — a real deployment (puttur-skin-clinic-landing) got stuck at PROVISIONING indefinitely with no error because of exactly this gap, the same class of bug already found and fixed once in execute-build.ts", () => {
  const source = fs.readFileSync(path.join(root, "trigger", "provision-runtime.ts"), "utf8");

  assert.match(source, /VERCEL_REQUEST_TIMEOUT_MS\s*=\s*25_000/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /signal:\s*controller\.signal/);

  // The timeout must actually throw a real error (isTimeout), not just
  // clear the handle and move on — an AbortError that gets silently
  // swallowed would be no better than the original unbounded hang.
  assert.match(source, /error\?\.name\s*===\s*"AbortError"/);
  assert.match(source, /timeoutError\.isTimeout\s*=\s*true/);
});

test("the whole task body is wrapped so any failure records a diagnosable event in our own database, not only visible on Trigger.dev's own dashboard as a failed run", () => {
  const source = fs.readFileSync(path.join(root, "trigger", "provision-runtime.ts"), "utf8");

  assert.match(source, /runProvisionRuntime\(db,\s*payload\)/);
  assert.match(source, /RUNTIME_PROVISION_ERROR/);

  // Best-effort: a failure recording the diagnostic event must never
  // swallow or replace the real error — it has to still propagate so
  // Trigger.dev's own task-level retry (and the deployment's own resume
  // mechanism) can actually react to it.
  const catchSection = source.slice(source.indexOf("}catch(error:any){\n   // Records"), source.indexOf("async function runProvisionRuntime"));
  assert.match(catchSection, /\.catch\(\(\)=>\{\}\)/);
  assert.match(catchSection, /throw error;/);
});
