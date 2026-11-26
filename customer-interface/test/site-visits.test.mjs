import assert from "node:assert/strict";
import test from "node:test";
import { cleanLandingPage, cleanToken, isBotUserAgent, recordSiteVisit, referrerHost, siteVisitLabels } from "../src/server/site-visits.mjs";
import { crossSiteWriteRefusal } from "../src/server/request-origin.mjs";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

test("a tagged link is counted by its source, medium and campaign", () => {
  assert.deepEqual(
    siteVisitLabels({ source: "YouTube", medium: "video", campaign: "claude-free-hosting", path: "/", userAgent: CHROME }),
    { source: "youtube", medium: "video", campaign: "claude-free-hosting", landingPage: "/" },
  );
});

test("an untagged visit uses the referring site, or (direct)", () => {
  assert.deepEqual(siteVisitLabels({ referrer: "https://claude.ai/directory", path: "/pricing/", userAgent: CHROME }), {
    source: "claude.ai", medium: "referral", campaign: "(none)", landingPage: "/pricing",
  });
  assert.equal(siteVisitLabels({ referrer: "https://m.facebook.com/", userAgent: CHROME }).source, "facebook.com");
  assert.equal(siteVisitLabels({ referrer: "https://utplava.dev/learn", userAgent: CHROME }).source, "(direct)");
  assert.equal(siteVisitLabels({ userAgent: CHROME }).source, "(direct)");
});

test("bots, link-preview crawlers and empty user agents are not counted", () => {
  for (const ua of ["facebookexternalhit/1.1", "meta-externalagent/1.1", "Baiduspider", "Googlebot/2.1", "curl/8.0", "python-requests/2.31", ""]) {
    assert.equal(isBotUserAgent(ua), true, ua);
    assert.equal(siteVisitLabels({ source: "youtube", userAgent: ua }), null);
  }
  assert.equal(isBotUserAgent(CHROME), false);
});

test("labels are cleaned so nothing odd or personal can be stored", () => {
  assert.equal(cleanToken("  <script>alert(1)</script> ", "x"), "script-alert-1-script");
  assert.equal(cleanToken("a".repeat(100), "x").length, 40);
  assert.equal(cleanToken("", "(none)"), "(none)");
  assert.equal(cleanLandingPage("/learn?email=me@x.com#top"), "/learn");
  assert.equal(cleanLandingPage("/<bad>"), "/other");
  assert.equal(referrerHost("javascript:alert(1)"), null);
  assert.equal(referrerHost("https://www.linkedin.com/feed/?u=123"), "linkedin.com");
});

test("recordSiteVisit adds one to the day's count", async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  await recordSiteVisit(db, { source: "x", medium: "social", campaign: "(none)", landingPage: "/" }, new Date("2026-11-26T10:00:00Z"));
  assert.match(calls[0].sql, /ON CONFLICT .* DO UPDATE SET visits = site_visits_daily.visits \+ 1/s);
  assert.deepEqual(calls[0].params, ["2026-11-26", "x", "social", "(none)", "/"]);
  await recordSiteVisit(db, null);
  assert.equal(calls.length, 1);
});

test("the visit counter accepts beacons from utplava.dev", () => {
  assert.equal(
    crossSiteWriteRefusal({ method: "POST", pathname: "/api/visit", requestHost: "app.utplava.dev", origin: "https://utplava.dev", secFetchSite: "same-site" }),
    null,
  );
});
