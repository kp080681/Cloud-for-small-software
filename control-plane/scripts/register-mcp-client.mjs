import pg from "pg";
import { randomBytes } from "node:crypto";
import { requireOperatorEnv } from "../src/operator-targeting.mjs";

// Registers a new MCP client (an AI platform allowed to request tokens).
// Deliberately operator-run, not self-service — see mcp/README.md and
// 022_mcp_oauth.sql for why this is a static allowlist rather than dynamic
// client registration (RFC 7591) for now.
//
// Usage:
//   MCP_CLIENT_NAME="Claude Code" \
//   MCP_CLIENT_REDIRECT_URIS="https://claude.ai/oauth/callback,https://claude.ai/api/mcp/callback" \
//   DATABASE_URL=... node scripts/register-mcp-client.mjs
for (const name of ["DATABASE_URL"]) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const name = requireOperatorEnv("MCP_CLIENT_NAME");
const redirectUris = requireOperatorEnv("MCP_CLIENT_REDIRECT_URIS")
  .split(",")
  .map((uri) => uri.trim())
  .filter(Boolean);

if (redirectUris.length === 0) {
  throw new Error("MCP_CLIENT_REDIRECT_URIS must list at least one redirect URI.");
}
// RFC 8252 (OAuth for native apps) treats a loopback HTTP redirect as
// secure enough for a native/CLI client specifically: the request never
// leaves the user's own machine, so there's no network eavesdropper for
// TLS to protect against, unlike a real https redirect_uri whose absence
// would matter. Found missing during an actual attempt to connect Claude
// Code (a real native client) to this server — its OAuth callback is
// exactly this kind of loopback URI, and the original https-only check
// rejected it outright with no exception, making every native/CLI client
// (Claude Code, Codex, and similar) impossible to register at all.
function isAcceptableRedirectUri(parsed) {
  if (parsed.protocol === "https:") return true;
  const isLoopbackHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  return parsed.protocol === "http:" && isLoopbackHost;
}

for (const uri of redirectUris) {
  const parsed = new URL(uri); // throws on malformed input
  if (!isAcceptableRedirectUri(parsed)) {
    throw new Error(`Redirect URI must use https:, or http: on localhost/127.0.0.1 for a native client: ${uri}`);
  }
}

const clientId = `mcp_${randomBytes(12).toString("base64url")}`;

const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const result = await db.query(
    `INSERT INTO mcp_clients (client_id, name, redirect_uris) VALUES ($1,$2,$3)
     RETURNING id, client_id, name, redirect_uris`,
    [clientId, name, redirectUris],
  );
  console.log(JSON.stringify({
    result: "MCP_CLIENT_REGISTERED",
    ...result.rows[0],
    next: "Give this client_id to the platform integrating with Utplava's MCP server. There is no client_secret — PKCE (S256) is the only credential a public client like this needs.",
  }, null, 2));
} finally {
  await db.end();
}
