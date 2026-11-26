-- Where utplava.dev visitors come from (2026-11-26): daily counts per source
-- tag (utm_source / utm_medium / utm_campaign, or the referring site when a
-- link has no tag) and the page they landed on. Counts only: no IPs, cookies,
-- user agents or anything that identifies a person. Known bots and link
-- preview crawlers (for example Meta's) are not counted.
BEGIN;

CREATE TABLE site_visits_daily (
  day date NOT NULL,
  source text NOT NULL,
  medium text NOT NULL,
  campaign text NOT NULL,
  landing_page text NOT NULL,
  visits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, medium, campaign, landing_page)
);

COMMIT;
