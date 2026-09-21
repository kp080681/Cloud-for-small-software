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
for (const uri of redirectUris) {
  const parsed = new URL(uri); // throws on malformed input
  if (parsed.protocol !== "https:") {
    throw new Error(`Redirect URI must use https: ${uri}`);
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
