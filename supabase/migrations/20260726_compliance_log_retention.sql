-- compliance_log retention — closes an unbounded-growth gap.
--
-- Motive (2026-07-26 scheduled health check): compliance_log has grown to
-- 297,450 rows since 2026-04-06 (~2,900 rows/day) with zero pruning —
-- every info/warning row from every 5-minute cron (market-data-fetcher,
-- surface-scanner, auto-trade, etc.) is retained forever. Sampling the most
-- recent 5,000 rows: 99.1% are severity 'info'/'warning' (routine run logs),
-- not audit-relevant events. This is the same unbounded-dead-data class as
-- the diagnostic_needed queue fixed in the 12th run today (PR #45) — no
-- consumer needs info/warning rows past a short window, but nothing was
-- ever evicting them (Agent Systems standard: long-term memory needs
-- eviction before unbounded growth, not after).
--
-- Fix: prune info/warning rows older than 30 days on a daily cron. error/
-- critical rows are never auto-deleted (audit trail / incident history —
-- see DECISIONS.md's reliance on querying past error rows by exact
-- timestamp). Also add a supporting index so the prune scans, not the
-- rest of this table's queries, and register the job in
-- expected_cron_jobs so the existing watchdog (cron_health(),
-- 20260725_expected_cron_manifest.sql) alerts if it ever stops running.

CREATE INDEX IF NOT EXISTS idx_compliance_log_severity_created_at
  ON public.compliance_log (severity, created_at);

CREATE OR REPLACE FUNCTION public.prune_compliance_log()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.compliance_log
  WHERE severity IN ('info', 'warning')
    AND created_at < now() - interval '30 days';
END;
$$;

SELECT cron.schedule(
  'compliance-log-retention-daily',
  '17 3 * * *',
  $$SELECT public.prune_compliance_log();$$
);

INSERT INTO public.expected_cron_jobs (jobname, note) VALUES
  ('compliance-log-retention-daily', 'daily prune of info/warning compliance_log rows older than 30d')
ON CONFLICT (jobname) DO NOTHING;
