// Which site sent a visitor to the free App safety check. Stores a short
// site name and a daily count only.

const ALIASES = [
  [/(^|\.)t\.co$|(^|\.)x\.com$|(^|\.)twitter\.com$/, "x.com"],
  [/(^|\.)google\./, "google"],
  [/(^|\.)bing\.com$/, "bing"],
  [/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/, "linkedin"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, "youtube"],
  [/(^|\.)whatsapp\.com$|(^|\.)wa\.me$/, "whatsapp"],
  [/(^|\.)glama\.ai$/, "glama"],
  [/(^|\.)utplava\.dev$/, "utplava.dev"],
];

export function normalizeSource(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text || text === "direct") return "direct";
  let host = text;
  try {
    if (/^[a-z]+:\/\//.test(text)) host = new URL(text).hostname;
  } catch {
    return "other";
  }
  host = host.replace(/^www\./, "");
  if (!/^[a-z0-9.-]{1,60}$/.test(host)) return "other";
  for (const [pattern, name] of ALIASES) if (pattern.test(host)) return name;
  return host;
}

export async function countCheckSource(db, raw, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  await db.query(
    `INSERT INTO public_check_sources (day, source, count) VALUES ($1, $2, 1)
     ON CONFLICT (day, source) DO UPDATE SET count = public_check_sources.count + 1`,
    [day, normalizeSource(raw)],
  );
}
