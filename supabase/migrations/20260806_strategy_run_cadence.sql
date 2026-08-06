-- Per-strategy run cadence.
-- run_interval_minutes: minimum minutes between auto-trade evaluations for this
--   strategy. NULL = hourly default (see DEFAULT_CADENCE_MIN in trading-logic.ts).
-- last_run_at: set by auto-trade each time the strategy passes its cadence gate.
--
-- Reconciliation note: the auto-trade-cron schedule itself was already bumped
-- from hourly to every 5 minutes directly via the Supabase management API on a
-- prior date (confirmed live: cron.job shows '*/5 * * * *' for auto-trade-cron),
-- but that change was never captured as a migration and the corresponding
-- code-side default-hourly throttle (this migration + the auto-trade cadence
-- gate) was never deployed. Until this ships, every strategy with a NULL
-- run_interval_minutes is being evaluated every 5 minutes instead of the
-- originally-intended hourly default.
ALTER TABLE strategies
  ADD COLUMN IF NOT EXISTS run_interval_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strategies_run_interval_positive'
  ) THEN
    ALTER TABLE strategies
      ADD CONSTRAINT strategies_run_interval_positive
      CHECK (run_interval_minutes IS NULL OR run_interval_minutes > 0) NOT VALID;
  END IF;
END $$;

ALTER TABLE strategies VALIDATE CONSTRAINT strategies_run_interval_positive;

-- Record-only: confirms cron.job already reflects the 5-min schedule live in
-- production. If it doesn't (e.g. a fresh environment), bring it in line.
DO $$
DECLARE jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'auto-trade-cron';
  IF jid IS NOT NULL THEN
    PERFORM cron.alter_job(job_id := jid, schedule := '*/5 * * * *');
  END IF;
END $$;
