-- paper-reconcile-cron was never actually registered in cron.job.
--
-- Root cause (found during the 2026-07-28 health-check run, 42nd): the
-- migration that was supposed to schedule it (20260727_paper_reconcile_cron.sql)
-- appended `ON CONFLICT (jobname) DO UPDATE ...` to a bare `SELECT
-- cron.schedule(...)` call — a SELECT has no ON CONFLICT semantics, so the
-- statement raised a syntax error and was never applied. This is the exact
-- same failure mode documented in 20260725_expected_cron_manifest.sql for
-- reconcile-orders-cron (a 6-day gap), copy-pasted forward into the new
-- migration along with the bug. paper-reconcile-cron also wasn't in
-- expected_cron_jobs, so cron_health()'s staleness watchdog couldn't flag it
-- as missing either — a job that never existed is invisible to a monitor
-- that only iterates `FROM cron.job`.
--
-- Impact: paper orders that don't fill instantly on placement were never
-- advanced past open/partial. 3 paper trades were stuck since 2026-07-27
-- 20:10 UTC (confirmed via query) until this fix registered the job live at
-- 2026-07-28 ~02:12 UTC. The next tick (02:17 UTC) picked them up and logged
-- a normal `paper_reconcile_run` heartbeat — verified in compliance_log.
--
-- Fix: cron.schedule() alone (it upserts by jobname internally — no ON
-- CONFLICT needed, that was the bug), plus registering it in the expected-
-- cron manifest so a future silent-deregistration is caught by cron_health()
-- instead of requiring a manual trades-table query to notice.

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

INSERT INTO public.expected_cron_jobs (jobname, note) VALUES
  ('paper-reconcile-cron', 'advance resting paper orders against real orderbook depth (2026-07-28: found never-registered, same class as reconcile-orders 6-day gap)')
ON CONFLICT (jobname) DO NOTHING;
