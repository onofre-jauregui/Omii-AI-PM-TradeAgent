-- Cron staleness + failure detection for the health-check watchdog.
--
-- Motive (2026-07-06): weather-signal-cron was parked to an impossible schedule
-- (`59 23 31 2 *` = Feb 31) and silently stopped firing for ~3h. The old
-- `agent_cron_health` view only counted FAILED runs, so a job that simply stops
-- scheduling (parked to a never-date, or stalled) showed 0 failures and read as
-- healthy. This closes that blind spot for the whole 11-job fleet.
--
-- Cadence is learned from each job's own run history (median gap over the last
-- 7 days) rather than parsed from the cron string — self-tuning, no brittle
-- schedule parsing. A job is STALE when it is active, has a known cadence, and
-- its last run is overdue by > 3x that cadence. Known limitation: a job dead
-- longer than the 7-day window loses its learned cadence and drops out of
-- staleness detection — by then coarser signals (trading_silence) fire.

CREATE OR REPLACE FUNCTION public.cron_health()
RETURNS TABLE (
  jobname                 text,
  schedule                text,
  active                  boolean,
  last_started_at         timestamptz,
  last_status             text,
  seconds_since_last_run  bigint,
  expected_interval_s     bigint,
  is_stale                boolean,
  last_run_failed         boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = cron, public
AS $$
  WITH last_runs AS (
    SELECT DISTINCT ON (jobid) jobid, start_time, status
    FROM cron.job_run_details
    ORDER BY jobid, start_time DESC
  ),
  cadence AS (
    SELECT jobid,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::bigint AS median_gap_s
    FROM (
      SELECT jobid,
             EXTRACT(EPOCH FROM (start_time -
               lag(start_time) OVER (PARTITION BY jobid ORDER BY start_time))) AS gap
      FROM cron.job_run_details
      WHERE start_time > now() - interval '7 days'
    ) g
    WHERE gap IS NOT NULL AND gap > 0
    GROUP BY jobid
  )
  SELECT
    j.jobname,
    j.schedule,
    j.active,
    lr.start_time AS last_started_at,
    lr.status     AS last_status,
    CASE WHEN lr.start_time IS NULL THEN NULL
         ELSE EXTRACT(EPOCH FROM (now() - lr.start_time))::bigint END AS seconds_since_last_run,
    c.median_gap_s AS expected_interval_s,
    (j.active
      AND c.median_gap_s IS NOT NULL
      AND lr.start_time IS NOT NULL
      AND EXTRACT(EPOCH FROM (now() - lr.start_time)) > (3 * c.median_gap_s)) AS is_stale,
    (j.active AND lr.status = 'failed') AS last_run_failed
  FROM cron.job j
  LEFT JOIN last_runs lr ON lr.jobid = j.jobid
  LEFT JOIN cadence  c  ON c.jobid  = j.jobid;
$$;

-- Infra internals — service_role (the health-check edge function) only.
REVOKE ALL ON FUNCTION public.cron_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_health() TO service_role;

-- Rebuild the manual-inspection view over the same logic, widened from the old
-- 6-of-11-job WHERE filter to the entire fleet.
DROP VIEW IF EXISTS public.agent_cron_health;
CREATE VIEW public.agent_cron_health AS
  SELECT * FROM public.cron_health() ORDER BY is_stale DESC, last_run_failed DESC, jobname;
