BEGIN;

-- App safety check: which website sent people to the checker, per day.
-- Only a site name (e.g. 'x.com', 'google', 'direct') and a count; nothing
-- about the visitor or the address they checked.
CREATE TABLE public_check_sources (
  day date NOT NULL,
  source text NOT NULL,
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (day, source)
);

COMMIT;
