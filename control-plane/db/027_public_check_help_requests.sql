BEGIN;

-- App safety check: people who chose to leave their email asking for help
-- fixing what the check found. Only what they typed in, plus the address
-- they asked about and its score.
CREATE TABLE public_check_help_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  target text NOT NULL,
  score integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX public_check_help_requests_created_idx ON public_check_help_requests (created_at DESC);

COMMIT;
