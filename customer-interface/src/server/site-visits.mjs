// Where utplava.dev visitors come from (2026-11-26). The marketing site sends
// one small beacon per browser tab when someone lands; this turns it into a
// daily count per source tag and landing page. Counts only: nothing about the
// person is stored (no IP, cookie, user agent or full referrer address).

const TOKEN = /[^a-z0-9._-]+/g;
const OWN_HOSTS = new Set(["utplava.dev", "app.utplava.dev"]);

// Link-preview crawlers, search bots and scripted clients. Meta's preview
// fetches showed up as "facebook.com" visits from its data-centre towns.
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|meta-external|facebookcatalog|preview|headless|lighthouse|pagespeed|python|curl|wget|httpclient|axios|node-fetch|go-http|java\/|baidu|yandex|semrush|ahrefs|bytespider|gptbot|claudebot|perplexity/i;

export function isBotUserAgent(userAgent) {
  const ua = String(userAgent || "").trim();
  return !ua || BOT_UA.test(ua);
}

export function cleanToken(value, fallback) {
  const token = String(value ?? "").toLowerCase().trim().replace(TOKEN, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return token || fallback;
}

export function referrerHost(referrer) {
  try {
    const url = new URL(String(referrer || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^(m|l|lm)\.(?=facebook\.com$)/, "");
    if (!host || OWN_HOSTS.has(host)) return null;
    return host.slice(0, 60);
  } catch {
    return null;
  }
}

export function cleanLandingPage(path) {
  const p = String(path || "/").split(/[?#]/)[0].toLowerCase().replace(/\/+$/, "") || "/";
  return /^\/[a-z0-9/_.-]{0,60}$/.test(p) ? p : "/other";
}

// Returns the labels to count, or null when the visit shouldn't be counted.
export function siteVisitLabels({ source, medium, campaign, referrer, path, userAgent } = {}) {
  if (isBotUserAgent(userAgent)) return null;
  const tagged = cleanToken(source, "");
  const host = tagged ? null : referrerHost(referrer);
  return {
    source: tagged || host || "(direct)",
    medium: tagged ? cleanToken(medium, "(none)") : host ? "referral" : "(none)",
    campaign: tagged ? cleanToken(campaign, "(none)") : "(none)",
    landingPage: cleanLandingPage(path),
  };
}

export async function recordSiteVisit(db, labels, now = new Date()) {
  if (!db || !labels) return;
  const day = now.toISOString().slice(0, 10);
  await db
    .query(
      `INSERT INTO site_visits_daily (day, source, medium, campaign, landing_page, visits)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (day, source, medium, campaign, landing_page)
       DO UPDATE SET visits = site_visits_daily.visits + 1`,
      [day, labels.source, labels.medium, labels.campaign, labels.landingPage],
    )
    .catch(() => {});
}
