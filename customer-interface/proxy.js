import { NextResponse } from "next/server";
import { legacyRedirectTarget } from "./src/server/app-host.mjs";
import { crossSiteWriteRefusal } from "./src/server/request-origin.mjs";

// Moves visitors from the old dashboard address to the canonical one
// (CANONICAL_APP_HOST). 308 keeps the method and body, so OAuth and MCP
// requests survive the move. See src/server/app-host.mjs.
// Also refuses cookie-authenticated writes that don't come from the
// dashboard's own pages (src/server/request-origin.mjs).
export function proxy(request) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const target = legacyRedirectTarget(request.url, process.env, host);
  if (target) return NextResponse.redirect(target, 308);
  const refusal = crossSiteWriteRefusal({
    method: request.method,
    pathname: request.nextUrl.pathname,
    requestHost: host,
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (refusal) return NextResponse.json({ error: "CROSS_SITE_REQUEST_BLOCKED" }, { status: 403 });
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
