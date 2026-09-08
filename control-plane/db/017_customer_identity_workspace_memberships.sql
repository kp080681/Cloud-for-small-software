BEGIN;

CREATE TABLE customer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  login text NOT NULL,
  display_name text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_account_id)
);

CREATE TABLE customer_workspace_memberships (
  customer_identity_id uuid NOT NULL REFERENCES customer_identities(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_identity_id, workspace_id)
);

CREATE INDEX customer_workspace_memberships_workspace_idx
  ON customer_workspace_memberships (workspace_id);

COMMIT;
