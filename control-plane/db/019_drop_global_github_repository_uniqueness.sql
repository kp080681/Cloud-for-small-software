BEGIN;

DO $$
DECLARE
  stale_constraint text;
  stale_index text;
BEGIN
  FOR stale_constraint IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'github_repositories'
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname ORDER BY key_position.ordinality)
        FROM unnest(c.conkey) WITH ORDINALITY AS key_position(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_position.attnum
      ) = ARRAY['github_installation_id', 'github_repository_id']
  LOOP
    EXECUTE format('ALTER TABLE public.github_repositories DROP CONSTRAINT %I', stale_constraint);
  END LOOP;

  FOR stale_index IN
    SELECT i.relname
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_constraint c ON c.conindid = ix.indexrelid
    WHERE n.nspname = 'public'
      AND t.relname = 'github_repositories'
      AND ix.indisunique
      AND c.oid IS NULL
      AND (
        SELECT array_agg(a.attname ORDER BY key_position.ordinality)
        FROM unnest(ix.indkey) WITH ORDINALITY AS key_position(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key_position.attnum
      ) = ARRAY['github_installation_id', 'github_repository_id']
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', stale_index);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS github_repositories_workspace_installation_repo_idx
  ON public.github_repositories (workspace_id, github_installation_id, github_repository_id);

COMMIT;
