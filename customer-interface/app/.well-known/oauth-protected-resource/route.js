import { protectedResourceHandler, metadataCorsOptionsRequestHandler } from "mcp-handler";

export const dynamic = "force-dynamic";

// RFC 9728 discovery: lets an MCP client that supports it learn where
// Utplava's authorization server lives (/api/mcp/authorize, /api/mcp/token)
// without a human hand-typing those URLs into a config file — the client
// mentioned to the founder in the "how does Claude Code know to call
// Utplava" conversation this endpoint answers.
//
// issuerUrl must be a stable, known value, not derived per-request (it
// identifies the authorization server itself, not the resource being
// fetched) — falls back to Vercel's stable production-domain system
// variable if MCP_ISSUER_URL isn't explicitly set. Note: Vercel's system
// environment variables require an opt-in project setting ("Enable access
// to System Environment Variables") — VERCEL_PROJECT_PRODUCTION_URL isn't
// guaranteed present just because this runs on Vercel. Resolved lazily,
// inside the request handler, rather than at module load: a missing
// config value should fail one request with a clear message, never break
// this route's import (and everything else in the same module graph)
// at build or cold-start time.
function issuerUrl() {
  if (process.env.MCP_ISSUER_URL) return process.env.MCP_ISSUER_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return null;
}

export function GET(request) {
  const url = issuerUrl();
  if (!url) {
    return Response.json(
      { error: "server_misconfigured", message: "Set MCP_ISSUER_URL, or enable Vercel's System Environment Variables for this project." },
      { status: 500 },
    );
  }
  return protectedResourceHandler({ authServerUrls: [url] })(request);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
