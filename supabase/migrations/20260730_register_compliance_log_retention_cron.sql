-- NOTE (2026-08-06): each cron.schedule() call below used to be closed by a
-- trailing upsert clause. That clause belongs to INSERT, not SELECT, so it was
-- invalid SQL and this file could never apply cleanly to any database, Supabase
-- included — it was recorded as applied without ever running to completion.
-- pg_cron's schedule() already replaces a job of the same name, so removing the
-- clause preserves the intent exactly. Found by scripts/rehearse-migrations.sh.

-- compliance-log-retention-daily was applied directly against the remote DB
-- (2026-07-07 health-check run, see .claude/improvement-log.md) via the
-- Supabase Management API, not through a committed migration — same class of
-- git/production drift already closed for settle-signals-cron
-- (20260728_register_settle_signals_cron.sql) and paper-reconcile-cron
-- (20260728_register_paper_reconcile_cron.sql). Root cause is a workflow gap,
-- not a bug: ad-hoc `curl .../database/query` fixes applied during an
-- unattended run satisfy the immediate need but leave no trace in git unless
-- someone remembers to also write the migration.
--
-- Impact so far: none observed — the job has run daily without incident
-- since 2026-07-07 (confirmed live in cron.job and cron_health(), 98th
-- health-check run). But until this migration, it was invisible to
-- expected_cron_jobs, so cron_health() could not have flagged a silent
-- deregistration, and a disaster-recovery rebuild from migrations alone
-- would silently omit it, letting compliance_log grow unbounded again.
--
-- Fix: capture the live function + cron.schedule() definition into git
-- (idempotent — CREATE OR REPLACE / upsert-by-name, safe to apply against a
-- database where the job already exists) and register it in
-- expected_cron_jobs so cron_health() covers it going forward.

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
  ('compliance-log-retention-daily', 'daily prune of info/warning compliance_log rows older than 30 days (2026-07-07: applied live via Management API during the first-ever health-check run, never captured into git until now — 98th run)')
ON CONFLICT (jobname) DO UPDATE SET note = excluded.note;
