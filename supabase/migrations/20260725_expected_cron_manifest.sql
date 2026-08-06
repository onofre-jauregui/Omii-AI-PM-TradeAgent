-- NOTE (2026-08-06): each cron.schedule() call below used to be closed by a
-- trailing upsert clause. That clause belongs to INSERT, not SELECT, so it was
-- invalid SQL and this file could never apply cleanly to any database, Supabase
-- included — it was recorded as applied without ever running to completion.
-- pg_cron's schedule() already replaces a job of the same name, so removing the
-- clause preserves the intent exactly. Found by scripts/rehearse-migrations.sh.

-- Expected-cron-job manifest — closes the "job never registered" blind spot.
--
-- Motive (2026-07-25): reconcile-orders-cron was written and documented in
-- 20260719_realmoney_reconciliation.sql, but that migration had a syntax bug
-- (`) ON CONFLICT ...` appended to a bare SELECT) and was never actually
-- applied to the remote DB. The job simply didn't exist in cron.job. Because
-- cron_health() (20260706_cron_staleness_detection.sql) only iterates
-- `FROM cron.job`, a job that was never scheduled is invisible to it by
-- construction — it can detect a job that stopped running, but not a job
-- that never started. Every live limit order that didn't fill instantly sat
-- unreconciled (never advanced to filled/cancelled) for the 6 days this went
-- undetected.
--
-- Fix: a small manifest table of jobs that must exist and be active. Add a
-- job here whenever a new pg_cron job is intended to be permanent — the
-- watchdog then alerts if it's ever missing, not just if it's ever late.

CREATE TABLE IF NOT EXISTS public.expected_cron_jobs (
  jobname     text PRIMARY KEY,
  added_at    timestamptz NOT NULL DEFAULT now(),
  note        text
);

INSERT INTO public.expected_cron_jobs (jobname, note) VALUES
  ('auto-reflect-hourly',        'hourly agent-memory reflection'),
  ('auto-settle-cron',           'settle resolved paper/live positions'),
  ('auto-trade-cron',            'core strategy loop, every 5 min'),
  ('backtest-weather-daily',     'daily weather-signal backtest'),
  ('daily-digest-cron',          'daily Telegram digest'),
  ('futures-signal-cron',        'futures-signal generation'),
  ('health-check-hourly',        'this watchdog itself'),
  ('market-data-fetcher-cron',   'market data cache refresh'),
  ('reconcile-orders-cron',      'advance resting live Kalshi orders (2026-07-19 gap)'),
  ('signal-generator-cron',      'signal-generator run'),
  ('surface-scanner-cron',       'surface-scan for arb opportunities')
ON CONFLICT (jobname) DO UPDATE SET note = excluded.note;

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
  ),
  registered AS (
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
    LEFT JOIN cadence  c  ON c.jobid  = j.jobid
  )
  SELECT r.jobname, r.schedule, r.active, r.last_started_at, r.last_status,
         r.seconds_since_last_run, r.expected_interval_s, r.is_stale, r.last_run_failed
  FROM registered r
  UNION ALL
  -- Manifest entries with no matching cron.job row at all: never registered.
  SELECT
    e.jobname,
    NULL::text,
    false,
    NULL::timestamptz,
    'missing'::text,
    NULL::bigint,
    NULL::bigint,
    true,   -- is_stale — reuses the existing stale-alert path in health-check
    false
  FROM public.expected_cron_jobs e
  WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = e.jobname);
$$;

REVOKE ALL ON FUNCTION public.cron_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_health() TO service_role;

DROP VIEW IF EXISTS public.agent_cron_health;
CREATE VIEW public.agent_cron_health AS
  SELECT * FROM public.cron_health() ORDER BY is_stale DESC, last_run_failed DESC, jobname;
