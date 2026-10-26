BEGIN;

-- App safety check (utplava.dev/check): fixed-window rate limits for the
-- free, signed-out scanner. `key` is a salted hash of the visitor's IP (or
-- the literal 'global' for the overall cap); raw IPs are never stored.
CREATE TABLE public_check_rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX public_check_rate_limits_window_idx ON public_check_rate_limits (window_start);

COMMIT;
