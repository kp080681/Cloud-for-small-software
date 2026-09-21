BEGIN;

-- Automatic anomaly-based suspension: when an app accumulates too many
-- failed deployments in a short window, it is paused so further deploy
-- attempts stop immediately with a clear reason, rather than a customer (or
-- an automated caller) silently burning provider build minutes retrying a
-- deployment that keeps failing for the same underlying reason. Follows the
-- same soft-flag convention already used for `deleted_at`. Resuming is a
-- deliberate, separate action (see control-plane/scripts/resume-app.mjs) —
-- pausing does not expire on its own once the failure window ages out.
ALTER TABLE apps
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN paused_reason text;

COMMIT;
