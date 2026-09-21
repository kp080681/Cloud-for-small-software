import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(here, "..", "schemas");

function loadTool(name) {
  return JSON.parse(readFileSync(path.join(schemasDir, `${name}.json`), "utf8"));
}

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

const TOOL_NAMES = ["deploy", "get_status", "get_logs", "set_env", "list_apps"];

for (const name of TOOL_NAMES) {
  test(`${name}: input and output are each well-formed JSON Schema`, () => {
    const tool = loadTool(name);
    assert.equal(tool.name, name);
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0);
    // ajv.compile throws on a malformed schema — this is the actual
    // structural validation, not just "the file parses as JSON".
    assert.doesNotThrow(() => ajv.compile(tool.input));
    assert.doesNotThrow(() => ajv.compile(tool.output));
  });
}

test("deploy: a realistic request and a fully-populated response both validate", () => {
  const tool = loadTool("deploy");
  const validateInput = ajv.compile(tool.input);
  const validateOutput = ajv.compile(tool.output);

  assert.equal(validateInput({ repo: "kp080681/my-app", branch: "main" }), true);
  assert.equal(validateInput({ repo: "kp080681/my-app" }), true);
  assert.equal(validateInput({}), false, "repo is required");
  assert.equal(validateInput({ repo: "not-a-valid-repo-shape" }), false, "repo must be owner/name");

  assert.equal(
    validateOutput({
      appId: "app_1",
      deploymentId: "dep_1",
      status: "needs_configuration",
      missingConfig: [{ key: "OPENAI_API_KEY", public: false }],
      message: "Your app needs an OpenAI key — add it, then deploy again.",
      url: null,
    }),
    true,
  );
  assert.equal(validateOutput({ appId: "app_1", deploymentId: "dep_1", status: "not_a_real_status", message: "x" }), false);
});

test("get_status: output covers a live app and a failed app needing attention", () => {
  const tool = loadTool("get_status");
  const validateOutput = ajv.compile(tool.output);

  assert.equal(
    validateOutput({
      status: "LIVE",
      stage: "Live",
      active: false,
      terminal: true,
      url: "https://my-app.utplava.app",
      message: "Your app is live.",
    }),
    true,
  );
  assert.equal(
    validateOutput({
      status: "FAILED",
      stage: "Something went wrong",
      active: false,
      terminal: true,
      url: null,
      message: "The build failed.",
      diagnostic: { code: "BUILD_FAILED", title: "Build failed", action: "Review the deployment build details before redeploying." },
    }),
    true,
  );
});

test("get_logs: respects the declared limit bounds", () => {
  const tool = loadTool("get_logs");
  const validateInput = ajv.compile(tool.input);
  assert.equal(validateInput({ appId: "app_1", limit: 10 }), true);
  assert.equal(validateInput({ appId: "app_1", limit: 0 }), false, "below minimum");
  assert.equal(validateInput({ appId: "app_1", limit: 51 }), false, "above maximum");

  const validateOutput = ajv.compile(tool.output);
  assert.equal(
    validateOutput({
      summary: "Your app deployed successfully.",
      entries: [{ at: "2026-09-21T10:00:00.000Z", title: "Build complete", evidence: { attempts: 1 } }],
    }),
    true,
  );
});

test("set_env: rejects an invalid key shape and an empty value at the schema level", () => {
  const tool = loadTool("set_env");
  const validateInput = ajv.compile(tool.input);
  assert.equal(validateInput({ appId: "app_1", key: "OPENAI_API_KEY", value: "sk-real-value" }), true);
  assert.equal(validateInput({ appId: "app_1", key: "not a valid key!", value: "x" }), false);
  assert.equal(validateInput({ appId: "app_1", key: "OPENAI_API_KEY", value: "" }), false, "minLength 1");
});

test("list_apps: takes no input properties and outputs a scoped app array", () => {
  const tool = loadTool("list_apps");
  const validateInput = ajv.compile(tool.input);
  assert.equal(validateInput({}), true);
  assert.equal(validateInput({ workspaceId: "workspace-a" }), false, "no workspace/customer param — scope comes from auth only");

  const validateOutput = ajv.compile(tool.output);
  assert.equal(
    validateOutput({ apps: [{ appId: "app_1", name: "My App", slug: "my-app", status: "LIVE", url: "https://my-app.utplava.app" }] }),
    true,
  );
});

test("every tool's declared errors reference a code, and mark whether it is retryable", () => {
  for (const name of TOOL_NAMES) {
    const tool = loadTool(name);
    assert.ok(Array.isArray(tool.errors), `${name} must declare an errors array, even if empty`);
    for (const err of tool.errors) {
      assert.equal(typeof err.code, "string");
      assert.equal(typeof err.retryable, "boolean");
    }
  }
});

test("no tool in this schema set is a destructive operation — delete/billing/workspace-management stay UI-only", () => {
  const destructiveNamePattern = /delete|destroy|billing|workspace.*(create|manage)/i;
  for (const name of TOOL_NAMES) {
    assert.doesNotMatch(name, destructiveNamePattern);
  }
});
