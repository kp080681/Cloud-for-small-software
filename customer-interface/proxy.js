import { NextResponse } from "next/server";
import { legacyRedirectTarget } from "./src/server/app-host.mjs";

// Moves visitors from the old dashboard address to the canonical one
// (CANONICAL_APP_HOST). 308 keeps the method and body, so OAuth and MCP
// requests survive the move. See src/server/app-host.mjs.
export function proxy(request) {
  const target = legacyRedirectTarget(request.url);
  if (target) return NextResponse.redirect(target, 308);
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
