-- paper-reconcile cron — advance resting paper orders against real Kalshi
-- orderbook depth every 5 minutes. Mirrors reconcile-orders-cron
-- (20260719_realmoney_reconciliation.sql) but for paper: no credentials
-- needed (public orderbook read), no real order to poll — re-simulates the
-- original requested fill against the current book instead.
--
-- Apply via the management API. Apply AFTER deploying the paper-reconcile
-- edge function.
--
-- Offset :02 — one minute after reconcile-orders-cron's :01, so the two
-- crons don't collide on the same tick (same staggering convention as
-- 20260525_stagger_cron_schedules.sql).

SELECT cron.schedule(
  'paper-reconcile-cron',
  '2-59/5 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL')
               || '/functions/v1/paper-reconcile',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body    := '{}'::jsonb
  );
  $$
);
-- NOTE (2026-07-28): the line above originally read
-- `) ON CONFLICT (jobname) DO UPDATE SET schedule = excluded.schedule;` —
-- SELECT has no ON CONFLICT semantics, so that was a syntax error that
-- silently aborted this entire migration (including the manifest INSERT
-- below) every time it was applied. cron.schedule() already upserts by
-- jobname internally, so the clause was redundant as well as invalid. Fixed
-- live via 20260728_register_paper_reconcile_cron.sql after the job was
-- found never-registered; corrected here too so a fresh migration replay
-- doesn't reintroduce the same failure. See that file for full root cause.

-- Register in the expected-cron manifest (20260725_expected_cron_manifest.sql)
-- so cron_health() alerts if this job is ever missing entirely, not just
-- stale — closing the exact blind spot that let reconcile-orders-cron sit
-- unregistered and undetected for 6 days.
INSERT INTO public.expected_cron_jobs (jobname, note) VALUES
  ('paper-reconcile-cron', 'advance resting paper orders vs real Kalshi orderbook depth')
ON CONFLICT (jobname) DO NOTHING;
