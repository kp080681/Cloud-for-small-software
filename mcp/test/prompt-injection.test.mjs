import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Item 10: adversarial testing for prompt injection via malicious repo
// content (README, code comments, package.json fields) aimed at
// manipulating the calling agent rather than the platform. Since no MCP
// server is implemented yet (that's item 9's earlier scope boundary, not
// this one), this suite audits by discovery: does the actual backend data
// this session built ever put attacker-controlled free text somewhere an
// agent reading a tool's response would see it as plausible instructions?

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");
const schemasDir = path.join(here, "..", "schemas");

function readTool(file) {
  return JSON.parse(fs.readFileSync(path.join(schemasDir, file), "utf8"));
}

function readSource(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), "utf8");
}

// Fields known, by direct source-code confirmation, to carry unconstrained
// free text an attacker fully controls (a repo owner sets these to
// anything, with spaces, punctuation, comments — none of the character
// restrictions that apply to an env var name or a GitHub repo slug).
const KNOWN_UNCONSTRAINED_ATTACKER_TEXT_FIELDS = [
  "buildCommand", // packageJson.scripts.build — completely free text
  "readme",
  "description", // package.json's own description field
];

// Collects every JSON Schema *property name* (not the schema's own
// "description" documentation strings, which every property legitimately
// has and would otherwise false-positive against the word "description"
// itself) at any depth of an output schema.
function collectPropertyNames(schema, names = new Set()) {
  if (!schema || typeof schema !== "object") return names;
  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, value] of Object.entries(schema.properties)) {
      names.add(key);
      collectPropertyNames(value, names);
    }
  }
  if (schema.items) collectPropertyNames(schema.items, names);
  return names;
}

for (const file of fs.readdirSync(schemasDir)) {
  test(`${file}: output schema never declares a known unconstrained-free-text property`, () => {
    const tool = readTool(file);
    const propertyNames = collectPropertyNames(tool.output);
    for (const field of KNOWN_UNCONSTRAINED_ATTACKER_TEXT_FIELDS) {
      assert.equal(propertyNames.has(field), false, `${file}'s output schema declares a "${field}" property, an unconstrained attacker-controlled field`);
    }
  });
}

test("no current code path reads README content at all — confirmed absent, not just unused by these schemas", () => {
  const hits = [];
  const scanDirs = [
    ["customer-interface", "src"],
    ["control-plane", "src"],
    ["control-plane", "trigger"],
  ];
  for (const segments of scanDirs) {
    const dir = path.join(repoRoot, ...segments);
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(mjs|ts)$/.test(entry.name) && !entry.name.includes(".test.")) {
          const content = fs.readFileSync(full, "utf8");
          if (/readme/i.test(content)) hits.push(full);
        }
      }
    };
    walk(dir);
  }
  assert.deepEqual(hits, []);
});

test("event titles shown in get_logs are always from a fixed lookup table, never interpolated with repo content", () => {
  const source = readSource("customer-interface", "src", "server", "customer-deployments.mjs");
  // The actual construction site: title comes from a table lookup with a
  // fixed fallback, never a template literal splicing in row/event data.
  assert.match(source, /title:\s*eventTitles\[customerType\]\s*\?\?\s*"[^"]+"/);
});

test("diagnostic title/action shown on failure are always from a fixed lookup table, never raw error text", () => {
  const source = readSource("customer-interface", "src", "server", "customer-deployments.mjs");
  assert.match(source, /const diagnostics = \{/);
  // Confirms the fallback path is also a fixed string, not `error.message`
  // or any other raw, potentially attacker-influenced value.
  assert.match(source, /\?\? \["Deployment needs attention", "Review deployment progress before retrying\.\"\]/);
});

test("get_logs evidence is key-allowlisted, which is documented as necessary but not sufficient — values are not content-sanitized", () => {
  const source = readSource("customer-interface", "src", "server", "customer-deployments.mjs");
  const blockedKeyPattern = /const blocked = \/secret\|token\|credential\|authorization\|ciphertext\|privateKey\|providerBody\|rawLog\|value\/i;/;
  assert.match(source, blockedKeyPattern, "safeEvidence's key-blocking pattern moved or changed — re-verify this whole finding if so");

  // The three keys this audit found carry residual, structurally-bounded
  // risk (identifier/hostname-shaped text an attacker can still choose,
  // just never free-form natural language). This test does not remove the
  // risk — it makes sure nobody can silently widen it without this test
  // forcing a deliberate look. If this assertion ever fails because one of
  // these was removed from the allowlist, that's a reduction in risk and
  // fine; if it fails because the allowlist changed shape entirely, this
  // whole audit needs re-running against the new list.
  const riskyKeys = ["missingKeys", "providerProjectName", "redirectLocationHost"];
  for (const key of riskyKeys) {
    assert.match(source, new RegExp(`"${key}"`), `${key} was expected in safeEvidenceKeys — if it's gone, update this audit`);
  }
});

test("env var key names are the narrowest of the three residual channels — confirms the character AND length constraints that bound them", () => {
  const source = readSource("control-plane", "src", "env-requirement-detection.mjs");
  // ENV_KEY_PATTERN — the same constraint that makes destructuring/dot/
  // bracket detection safe also bounds what text can ever reach an agent
  // via missingConfig[].key or evidence.missingKeys: identifiers only, no
  // spaces, no punctuation, nothing that reads as a natural-language
  // sentence regardless of how an attacker names their variable. Capped
  // at 64 characters after an independent review (Opus 5.5) demonstrated
  // a concrete 76-character suggestive identifier that fit the original,
  // uncapped pattern — this test intentionally fails if the pattern
  // changes shape again, forcing this finding to be re-examined rather
  // than silently going stale.
  assert.match(source, /ENV_KEY_PATTERN\s*=\s*\/\^\[A-Za-z_\]\[A-Za-z0-9_\]\{0,63\}\$\//);
});
