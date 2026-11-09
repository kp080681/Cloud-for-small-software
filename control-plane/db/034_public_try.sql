-- 034: Try before sign-in (2026-11-09).
-- The sign-in page lets visitors preview a pasted page (entirely in their
-- browser) and check a public GitHub repository before signing in. The
-- repository check is the only server work a signed-out visitor can cause,
-- so it is rate-limited per visitor (hashed IP, never stored raw) and
-- overall. Nothing about the visitor or their repository is kept.

BEGIN;

CREATE TABLE IF NOT EXISTS public_rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS public_rate_limits_window_idx ON public_rate_limits (window_start);

COMMIT;
