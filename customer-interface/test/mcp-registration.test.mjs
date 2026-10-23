import test from "node:test";
import assert from "node:assert/strict";
import {
  REGISTRATIONS_PER_HOUR,
  RegistrationError,
  isAcceptableRedirectUri,
  registerMcpClient,
  safeReturnTo,
  validateRegistrationRequest,
} from "../src/server/mcp-registration.mjs";

class FakeDb {
  constructor(recent = 0) {
    this.recent = recent;
    this.inserted = [];
  }
  async query(text, params) {
    if (text.includes("count(*)")) return { rows: [{ n: this.recent }] };
    if (text.includes("INSERT INTO mcp_clients")) {
      this.inserted.push(params);
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unhandled fake query: ${text}`);
  }
}

test("real MCP client redirect URIs are accepted", () => {
  for (const uri of [
    "https://claude.ai/api/mcp/auth_callback",
    "http://localhost:53682/callback",
    "http://127.0.0.1:33418/",
    "http://[::1]:8080/cb",
    "cursor://anysphere.cursor-retrieval/oauth/user-utplava/callback",
    "vscode://vscode.github-authentication/did-authenticate",
    "https://vscode.dev/redirect",
  ]) {
    assert.equal(isAcceptableRedirectUri(uri), true, uri);
  }
});

test("dangerous or sloppy redirect URIs are refused", () => {
  for (const uri of [
    "http://evil.example/cb",
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "https://claude.ai/cb#frag",
    "not a url",
    "",
    "https://" + "a".repeat(2100) + ".com/",
    "chrome-extension://abc/cb",
  ]) {
    assert.equal(isAcceptableRedirectUri(uri), false, uri);
  }
});

test("registration returns a public client and stores exactly what was asked", async () => {
  const db = new FakeDb();
  const result = await registerMcpClient(
    db,
    { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "client_secret_post" },
    { now: 1_700_000_000_000, idFactory: () => "mcp_test" },
  );
  assert.equal(result.client_id, "mcp_test");
  assert.equal(result.token_endpoint_auth_method, "none");
  assert.equal(result.client_secret, undefined);
  assert.deepEqual(result.grant_types, ["authorization_code", "refresh_token"]);
  assert.equal(result.client_id_issued_at, 1_700_000_000);
  assert.deepEqual(db.inserted, [["mcp_test", "Claude", ["https://claude.ai/api/mcp/auth_callback"]]]);
});

test("names are cleaned so they can't fake text on the consent screen", () => {
  const { name } = validateRegistrationRequest({ client_name: "Claude‮\u0000\n  Code   ", redirect_uris: ["https://claude.ai/cb"] });
  assert.equal(name, "Claude Code");
  assert.equal(validateRegistrationRequest({ redirect_uris: ["https://x.example/cb"] }).name, "An MCP client");
  assert.equal(validateRegistrationRequest({ client_name: "x".repeat(500), redirect_uris: ["https://x.example/cb"] }).name.length, 80);
});

test("unsupported grants and shapes are refused with RFC 7591 errors", () => {
  const bad = [
    [null, "invalid_client_metadata"],
    [{ redirect_uris: [] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] }, "invalid_client_metadata"],
    [{ redirect_uris: ["https://a.example/cb"], grant_types: ["refresh_token"] }, "invalid_client_metadata"],
    [{ redirect_uris: ["https://a.example/cb"], response_types: ["token"] }, "invalid_client_metadata"],
    [{ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) }, "invalid_redirect_uri"],
  ];
  for (const [body, code] of bad) {
    assert.throws(() => validateRegistrationRequest(body), (e) => e instanceof RegistrationError && e.error === code);
  }
});

test("a registration flood is cut off", async () => {
  await assert.rejects(
    registerMcpClient(new FakeDb(REGISTRATIONS_PER_HOUR), { redirect_uris: ["https://a.example/cb"] }),
    (e) => e.status === 429 && e.error === "temporarily_unavailable",
  );
});

test("after sign-in, people can only be returned to the MCP authorize or consent screens", () => {
  assert.equal(safeReturnTo("/api/mcp/authorize?client_id=a&state=b"), "/api/mcp/authorize?client_id=a&state=b");
  assert.equal(safeReturnTo("/mcp/consent?client_id=a"), "/mcp/consent?client_id=a");
  for (const value of [
    "https://evil.example/api/mcp/authorize?x",
    "//evil.example/api/mcp/authorize?x",
    "/api/mcp/authorizeX",
    "/settings",
    "/api/mcp/authorize?\\@evil",
    "/mcp/consent?\nSet-Cookie:x",
    null,
    undefined,
  ]) {
    assert.equal(safeReturnTo(value), null, String(value));
  }
});
