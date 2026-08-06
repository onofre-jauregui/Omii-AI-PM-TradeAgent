-- NOTE (2026-08-06): each cron.schedule() call below used to be closed by a
-- trailing upsert clause. That clause belongs to INSERT, not SELECT, so it was
-- invalid SQL and this file could never apply cleanly to any database, Supabase
-- included — it was recorded as applied without ever running to completion.
-- pg_cron's schedule() already replaces a job of the same name, so removing the
-- clause preserves the intent exactly. Found by scripts/rehearse-migrations.sh.

-- settle-signals-cron was never actually registered, and the columns it
-- writes to never existed on `signals` — despite both being part of a
-- migration (20260504120000_v2_instrumentation_and_lock.sql) that
-- `schema_migrations` has recorded as applied since 2026-05-04.
--
-- Root cause (found during the 2026-07-28 health-check run, 46th): same
-- swallowed-migration-failure bug closed for the CI runner earlier this run
-- (`.github/workflows/ci.yml`'s `curl -sf ... || echo WARN`, see the 45th-run
-- entry) — this migration predates that fix by nearly three months and was
-- itself a casualty of it. `signals.settlement_price` / `shadow_pnl` /
-- `settled_at` / `system_version` do not exist on this project despite the
-- migration's `ALTER TABLE ... ADD COLUMN` lines (confirmed via
-- `information_schema.columns`), and `settle-signals-cron` has zero rows in
-- `cron.job` despite the same migration's `SELECT cron.schedule(...)` call.
-- Whichever statement in that multi-statement migration failed first,
-- everything after it (including both the columns and the cron
-- registration) silently never applied while the runner still recorded the
-- migration as a success.
--
-- Impact: `settle-signals` — the function that computes shadow PnL for every
-- signal the qualifier skipped, described in its own docstring as "the
-- biggest data unlock in v2" for measuring qualifier ROI — has run zero
-- times, ever (compliance_log has no `settle_signals_run`/`settle_signals_error`
-- rows in its history). 20,936 of 21,782 signals are past `expires_at` and
-- unsettled. `qualifier_roi_v2` (20260504_v2_validation_queries.sql) has been
-- empty since the day it was created. Compounding this: the function's
-- `.select(...)` destructures only `data` from the Postgrest response, never
-- checking `error` — so once the missing `system_version` column made every
-- query fail, the error was silently discarded and the function reported a
-- clean `{settled: 0, reason: "No unsettled signals past expiration"}` 200
-- instead of surfacing the failure (fixed alongside this migration in
-- `supabase/functions/settle-signals/index.ts`).
--
-- Fix: add the missing columns (idempotent, additive, nullable — no data
-- migration needed) and register the cron job exactly as the original
-- migration intended, plus add it to expected_cron_jobs so a future silent
-- drop is caught by cron_health() instead of requiring a manual audit to
-- notice (same closing move as 20260728_register_paper_reconcile_cron.sql).
-- Read-only against Kalshi (GET market data only) and writes only to
-- `signals` — no trading/order-placement path touched.

ALTER TABLE signals ADD COLUMN IF NOT EXISTS shadow_pnl numeric;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS settlement_price numeric;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS settled_at timestamptz;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS direction_correct bool;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS profitable bool;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS system_version text DEFAULT 'v1';

SELECT cron.schedule(
  'settle-signals-cron',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL')
               || '/functions/v1/settle-signals',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body    := '{}'::jsonb
  );
  $$
);

INSERT INTO public.expected_cron_jobs (jobname, note) VALUES
  ('settle-signals-cron', 'shadow-PnL settlement for skipped signals — qualifier ROI input (2026-07-28: found never-registered + missing columns, migration recorded applied 2026-05-04 but silently failed, same class as reconcile-orders/paper-reconcile gaps)')
ON CONFLICT (jobname) DO UPDATE SET note = excluded.note;
