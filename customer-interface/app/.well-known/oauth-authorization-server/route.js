import { metadataCorsOptionsRequestHandler } from "mcp-handler";

import { mcpIssuerUrl } from "@/src/server/app-host.mjs";

export const dynamic = "force-dynamic";

// RFC 8414 Authorization Server Metadata. Without this, a spec-compliant
// client that discovers our issuer (via the RFC 9728 Protected Resource
// document at ../oauth-protected-resource) has no way to learn the real
// authorize/token endpoint paths, and falls back to guessing
// <issuer>/authorize and <issuer>/token directly off the bare domain —
// which 404s, since our real endpoints live under /api/mcp/. Confirmed
// live: this exact failure happened on the first real attempt to connect
// Claude Code, a genuine spec-compliant client, to this server. Opus 5.5's
// first-pass review had already flagged this document's absence as a
// launch blocker; it just hadn't been built yet.
//
// issuerUrl mirrors ../oauth-protected-resource/route.js's lazy resolution
// exactly: resolved inside the handler, never at module load, so a
// missing env var fails one request cleanly instead of crashing this
// route's import (and everything else in the same module graph) at build
// or cold-start time.
function issuerUrl() {
  // MCP_ISSUER_URL, else https://CANONICAL_APP_HOST, else Vercel's production URL.
  return mcpIssuerUrl();
}

export function GET() {
  const issuer = issuerUrl();
  if (!issuer) {
    return Response.json(
      { error: "server_misconfigured", message: "Set MCP_ISSUER_URL, or enable Vercel's System Environment Variables for this project." },
      { status: 500 },
    );
  }
  return Response.json({
    issuer,
    authorization_endpoint: `${issuer}/api/mcp/authorize`,
    token_endpoint: `${issuer}/api/mcp/token`,
    // Dynamic client registration (RFC 7591), added 2026-10-23: standard
    // MCP clients register themselves here before sending the person to sign in.
    registration_endpoint: `${issuer}/api/mcp/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // "none": there is no client_secret — PKCE (S256) is the only
    // credential a public client like this needs, by design (see
    // register-mcp-client.mjs and mcp/README.md).
    token_endpoint_auth_methods_supported: ["none"],
  });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
