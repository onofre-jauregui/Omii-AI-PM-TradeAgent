-- Bump the auto-trade cron from hourly (5 * * * *) to every 5 minutes (*/5 * * * *).
-- This is the finest cadence worth supporting: the signal pipeline (surface-scanner,
-- market-data-fetcher) regenerates prices every 5 min, so evaluating faster than that
-- just re-reads identical data.
--
-- Safe because the per-strategy cadence gate (shouldRunByCadence in _shared/trading-logic.ts)
-- now treats a NULL run_interval_minutes as the hourly DEFAULT_CADENCE_MIN rather than
-- "run every tick". Without that change, every default strategy would trade 12x more once
-- the cron dropped below an hour. The gate + hourly-default were deployed with the
-- auto-trade function BEFORE this schedule change (verified: NULL strategies skip with
-- "next run in 60m" on back-to-back invocations).
--
-- Applied live via the Supabase management API (never `supabase db push`); this file is
-- the repo record. Idempotent — looks the job up by name so it survives job_id drift.
DO $$
DECLARE jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'auto-trade-cron';
  IF jid IS NOT NULL THEN
    PERFORM cron.alter_job(job_id := jid, schedule := '*/5 * * * *');
  END IF;
END $$;
