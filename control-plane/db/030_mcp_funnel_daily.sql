-- Daily counts of how far people get when they connect an AI tool to Utplava
-- (2026-11-04): welcome page seen, GitHub sign-in started, consent screen
-- seen. Numbers only: no names, emails, IPs or tokens. "Allowed" is already
-- in mcp_authorization_codes.
BEGIN;

CREATE TABLE mcp_funnel_daily (
  day date NOT NULL,
  step text NOT NULL,
  client text NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, step, client)
);

COMMIT;
