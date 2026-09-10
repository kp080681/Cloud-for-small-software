import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const scanRoots = ["app", "src"];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(fullPath)));
    } else if (/\.(js|mjs|jsx|ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function sourceFiles() {
  const directories = scanRoots.map((name) => path.join(root, name));
  const nested = await Promise.all(directories.map(filesUnder));
  return nested.flat();
}

test("customer interface does not import provider lifecycle operations", async () => {
  const forbidden = [
    "VERCEL_TOKEN",
    "NEON_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "@trigger.dev",
    "queueDeployment",
    "execute-build",
    "provision-runtime",
    "provision-database",
    "delete-app",
    "deployment_provider_operations",
    "app_runtimes",
    "deployment_builds",
    "deployment_health_checks",
  ];

  for (const file of await sourceFiles()) {
    const text = await readFile(file, "utf8");
    for (const token of forbidden) {
      assert.equal(text.includes(token), false, `${path.relative(root, file)} contains ${token}`);
    }
  }
});

test("Trigger credential access is isolated to the deployment-start boundary", async () => {
  for (const file of await sourceFiles()) {
    const text = await readFile(file, "utf8");
    if (!text.includes("TRIGGER_SECRET_KEY")) continue;
    assert.equal(
      path.relative(root, file),
      path.join("src", "server", "customer-deployments.mjs"),
      "Trigger secret must stay inside the server deployment-start boundary",
    );
  }
});

test("KMS key access is isolated to the customer secret-store boundary", async () => {
  for (const file of await sourceFiles()) {
    const text = await readFile(file, "utf8");
    if (!text.includes("AWS_KMS_KEY_ID")) continue;
    assert.equal(
      path.relative(root, file),
      path.join("src", "shared", "control-plane", "secret-store.mjs"),
      "KMS key id must stay inside the server secret-store boundary",
    );
  }
});

test("GitHub App private key access is isolated to the server adapter", async () => {
  for (const file of await sourceFiles()) {
    const text = await readFile(file, "utf8");
    if (!text.includes("GITHUB_APP_PRIVATE_KEY")) continue;
    assert.equal(
      path.relative(root, file),
      path.join("src", "server", "github-app.mjs"),
      "GitHub App private key must stay out of route/client modules",
    );
  }
});

test("customer interface does not use prototype client-side identity simulation", async () => {
  for (const file of await sourceFiles()) {
    const text = await readFile(file, "utf8");
    assert.equal(text.includes("sessionStorage"), false, `${path.relative(root, file)} uses sessionStorage`);
    assert.equal(text.includes("localStorage"), false, `${path.relative(root, file)} uses localStorage`);
    assert.equal(text.includes("fixture"), false, `${path.relative(root, file)} references fixtures`);
  }
});

test("workspace and session APIs use the authenticated customer-session guard", async () => {
  const apiFiles = [
    "app/api/auth/session/route.js",
    "app/api/workspaces/route.js",
    "app/api/workspaces/[workspaceId]/route.js",
    "app/api/workspaces/[workspaceId]/applications/[appId]/configuration/route.js",
    "app/api/workspaces/[workspaceId]/applications/[appId]/configuration/secrets/route.js",
    "app/api/workspaces/[workspaceId]/applications/[appId]/deployments/[deploymentId]/route.js",
    "app/api/workspaces/[workspaceId]/applications/[appId]/deployments/[deploymentId]/start/route.js",
  ];

  for (const relative of apiFiles) {
    const text = await readFile(path.join(root, relative), "utf8");
    assert.equal(text.includes("requireCustomerSession"), true, `${relative} lacks customer-session guard`);
  }
});

test("sidebar GitHub connection control targets the rendered GitHub panel", async () => {
  const page = await readFile(path.join(root, "app", "page.js"), "utf8");
  const panel = await readFile(path.join(root, "app", "github-panel.js"), "utf8");

  assert.equal(page.includes('href="#github-connection"'), true);
  assert.equal(page.includes("<button disabled>GitHub connection</button>"), false);
  assert.equal(panel.includes('id="github-connection"'), true);
});

test("PostgreSQL client is bundled for Vercel server runtime resolution", async () => {
  const config = await readFile(path.join(root, "next.config.mjs"), "utf8");

  assert.match(config, /transpilePackages:\s*\[\s*"pg"\s*\]/);
});
