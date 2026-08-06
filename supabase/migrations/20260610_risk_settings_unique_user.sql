-- Enforce one risk_settings row per user so upsert works correctly.
-- Without this, onboarding inserts duplicate rows and auto-trade falls back
-- to the system default (max_open_positions=10) for users missing an explicit row.
--
-- Guarded on pg_constraint because Postgres has no ADD CONSTRAINT IF NOT EXISTS.
-- Unguarded, this migration failed with 42P07 on every re-run - the same defect
-- already fixed in 20260803_subscriptions_unique_user_and_comp_grants.sql and
-- never swept for elsewhere. It is one of the reasons the migration set was not
-- replayable, which scripts/rehearse-migrations.sh now proves on every push.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'risk_settings_user_id_unique'
      AND conrelid = 'public.risk_settings'::regclass
  ) THEN
    ALTER TABLE public.risk_settings
      ADD CONSTRAINT risk_settings_user_id_unique UNIQUE (user_id);
  END IF;
END
$$;
