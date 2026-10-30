BEGIN;

-- Custom domains (2026-10-30): a customer's own domain connected to an app.
-- One active domain per app (an apex domain also brings its www, which
-- redirects to it). A domain can only be connected to one app at a time;
-- rows are kept after removal (status REMOVED) for history, and the unique
-- indexes below ignore them so the domain can be connected again later.
CREATE TABLE app_custom_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 253),
  apex_name text,
  include_www boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'NEEDS_DNS', 'SECURING', 'ACTIVE', 'FAILED', 'REMOVING', 'REMOVED')),
  -- Who runs the domain's DNS (recognised from its nameservers) and the
  -- records the customer must add or delete, as last computed. Public DNS
  -- facts only; nothing secret is stored here.
  dns_provider_key text,
  dns_provider_name text,
  records jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  www_ready boolean NOT NULL DEFAULT false,
  problem_code text,
  problem text,
  check_requested_at timestamptz,
  last_checked_at timestamptz,
  active_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX app_custom_domains_one_per_app
  ON app_custom_domains (app_id) WHERE status <> 'REMOVED';
CREATE UNIQUE INDEX app_custom_domains_domain_unique
  ON app_custom_domains (domain) WHERE status <> 'REMOVED';
CREATE INDEX app_custom_domains_recheck_idx
  ON app_custom_domains (status, last_checked_at) WHERE status IN ('PENDING', 'NEEDS_DNS', 'SECURING', 'ACTIVE');

COMMIT;
