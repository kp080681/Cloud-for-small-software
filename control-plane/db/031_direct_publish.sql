-- 031: Direct publishing (2026-11-06).
-- People without GitHub upload files (or paste HTML) on the dashboard or
-- from an AI chat. Utplava keeps that code in a private repository in a
-- GitHub organisation Utplava owns, so the existing deploy pipeline runs
-- unchanged. Those repositories are marked managed_by_utplava and are
-- never linked to any workspace's GitHub connection, so no other
-- workspace can list or select them.

BEGIN;

ALTER TABLE github_repositories
  ADD COLUMN IF NOT EXISTS managed_by_utplava boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS display_name text;

-- One row per publish attempt that passed the checks, for auditing,
-- support and abuse review. Never stores file contents.
CREATE TABLE IF NOT EXISTS direct_publishes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,
  customer_identity_id uuid REFERENCES customer_identities(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('dashboard', 'mcp')),
  file_count integer NOT NULL,
  total_bytes integer NOT NULL,
  content_sha256 text NOT NULL,
  commit_sha text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS direct_publishes_workspace_created_idx
  ON direct_publishes (workspace_id, created_at DESC);

-- Takedown: the existing manual-review pause already blocks every deploy
-- path (dashboard, MCP, push, republish). To stop an abusive app:
--   UPDATE apps SET paused_at = now(), paused_reason = 'Removed: reported abuse' WHERE id = '...';
-- then delete it from the dashboard to take the live link down.

COMMIT;
