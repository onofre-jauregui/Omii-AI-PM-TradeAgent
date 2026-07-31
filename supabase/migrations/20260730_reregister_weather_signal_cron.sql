-- Re-register weather-signal-cron — it does not exist in cron.job at all.
--
-- Motive (2026-07-30 production-readiness audit): 20260706_cron_staleness_detection.sql
-- documents that weather-signal-cron was found parked to an impossible schedule
-- (`59 23 31 2 *` = Feb 31) on 2026-07-06. Live cron.job query during this audit
-- confirms it isn't parked — it's gone entirely, no row for this jobname exists.
-- S-005 (weather-edge) is seeded active for every user who completes onboarding
-- (20260415_paper_trading_pipeline.sql), but with no cron ever generating fresh
-- weather signals, S-005 has been running dead: active, advertised to users, and
-- structurally starved of the signals it needs to ever qualify a trade.
--
-- It was also never added to expected_cron_jobs (20260725_expected_cron_manifest.sql),
-- so the "job never registered" watchdog — built specifically to catch this exact
-- failure mode for reconcile-orders-cron — could not have caught this one. Same
-- gap applies to paper-reconcile-cron and settle-signals-cron, both live in
-- cron.job today but absent from the manifest; closing all three here.
--
-- Schedule restored from 20260525_stagger_cron_schedules.sql's staggered sequence
-- (:04/:14/:24/:34/:44/:54, every 10 min) — that slot remains free in the current
-- fleet, confirmed against a live cron.job query during this migration.

-- No ON CONFLICT here — cron.schedule() returns a bigint jobid, not a row,
-- so `SELECT cron.schedule(...) ON CONFLICT ...` is invalid SQL and silently
-- never applies (this exact bug is what caused reconcile-orders-cron to go
-- unregistered for 6 days, per 20260725_expected_cron_manifest.sql's motive
-- comment — not repeating it here). The job doesn't exist at all right now,
-- confirmed by a live cron.job query, so a plain schedule() call is correct.
SELECT cron.schedule(
  'weather-signal-cron',
  '4,14,24,34,44,54 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL')
               || '/functions/v1/weather-signal',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body    := '{}'::jsonb
  );
  $$
);

INSERT INTO public.expected_cron_jobs (jobname, note) VALUES
  ('weather-signal-cron',   'S-005 weather-edge signal generation (found completely deregistered 2026-07-30 — see migration comment)'),
  ('paper-reconcile-cron',  'advance resting paper Kalshi-simulated orders'),
  ('settle-signals-cron',   'shadow P&L for all signals, traded or not — feeds the LLM-qualifier ROI loop')
ON CONFLICT (jobname) DO NOTHING;
