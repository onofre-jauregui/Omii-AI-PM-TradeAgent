-- Close a live security hole surfaced by the rls_disabled_tables() RPC
-- (20260731_p0_strategy_config_seed_and_grants.sql) the moment it was first
-- applied and callable (104th scheduled health check, 2026-08-03): two
-- service-managed tables had RLS fully OFF with full CRUD+TRUNCATE grants
-- to anon/authenticated — i.e. world-writable via the public anon key that
-- ships in the frontend bundle.
--
-- weather_bucket_calibration: per-trade calibration ledger (pnl, resolution,
-- bucket_threshold) the Weather Edge (S-005) strategy and auto-settle read —
-- anon could corrupt or wipe strategy calibration data.
-- expected_cron_jobs: the cron-manifest table cron_health() diffs against to
-- detect a missing job (added in the 100th health-check run specifically to
-- catch silent cron drift) — anon could delete rows to mask a real missing
-- job, defeating that safety net, or insert bogus rows to create false
-- "missing" alert noise.
--
-- Fix matches this repo's existing service-role-only pattern (auto_trade_locks,
-- signals, compliance_log): enable RLS with zero policies = default-deny for
-- anon/authenticated, service_role keeps full access via BYPASSRLS. No
-- legitimate client ever reads these tables directly — both are edge-function-
-- internal, always accessed via the service-role key.

ALTER TABLE public.weather_bucket_calibration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expected_cron_jobs ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.weather_bucket_calibration, public.expected_cron_jobs
  FROM anon, authenticated;
REVOKE SELECT ON public.weather_bucket_calibration, public.expected_cron_jobs FROM anon;
