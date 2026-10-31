"use client";

import { Analytics } from "@vercel/analytics/next";

// Cookie-free page counts for the dashboard (2026-10-30). Addresses here
// carry app and workspace ids and OAuth parameters, so every reported URL
// is reduced to its page shape: query strings dropped, ids replaced.
function pageShape(event) {
  try {
    const url = new URL(event.url);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
      .replace(/\/\d+(?=\/|$)/g, "/:n");
    return { ...event, url: url.toString() };
  } catch {
    return null;
  }
}

export function PageAnalytics() {
  return <Analytics beforeSend={pageShape} />;
}
