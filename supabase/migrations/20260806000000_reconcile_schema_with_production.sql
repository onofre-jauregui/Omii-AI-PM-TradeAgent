-- Reconcile the migration set with what production actually looks like.
--
-- Rebuilding from `supabase/migrations/` produced a database that passed the
-- object-count assertion while differing from production in twelve RLS policies,
-- three column types, four constraints and two index names. Counts matched by
-- coincidence; the schemas did not. Every statement below was derived by diffing
-- the rebuilt catalog against production's on 2026-08-06 and is a no-op there,
-- because production is the side that is already correct.
--
-- The two differences that make a rebuilt database unusable rather than merely
-- untidy:
--
--   1. `Allow all access to api_keys` — FOR ALL, TO public, USING (true) — still
--      exists in the migration set. Postgres OR's permissive policies, so it
--      overrides `api_keys_user_isolation` and exposes every user's encrypted
--      Kalshi credentials to `anon` through PostgREST. Production dropped it by
--      hand and the drop was never written down. Same for risk_settings,
--      strategies and compliance_log.
--   2. `compliance_log`'s inline CHECK from 20260402000000 is a closed allowlist
--      of fourteen event types that excludes `health_check_alert`, which
--      20260726_alert_dedup_race.sql writes. Production replaced it with the
--      category-gated `compliance_event_type_allowlist`. A rebuilt database
--      would reject writes production accepts.

-- Column types, defaults and nullability are corrected at source rather than
-- here — in 20260415_paper_trading_pipeline.sql, 20260422_waitlist.sql and
-- 20260504120000_v2_instrumentation_and_lock.sql. Those files are recorded as
-- applied in production, so amending a declaration changes nothing there and
-- makes git describe what the migration actually produced. Reconciling by
-- ALTER instead would fail on the rebuild: `signals.edge_cents` is referenced
-- by the `agent_signal_health` view, and Postgres refuses to retype a column a
-- view depends on.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Drop the permissive policies production no longer has
--
-- These are the original pre-multi-tenancy policies. Each is FOR ALL / USING
-- (true) and each sits on a table that also carries a correct user-isolation
-- policy — which the permissive one silently defeats.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Allow all access to api_keys"       ON public.api_keys;
DROP POLICY IF EXISTS "Allow all access to risk_settings"  ON public.risk_settings;
DROP POLICY IF EXISTS "Allow all access to strategies"     ON public.strategies;
DROP POLICY IF EXISTS "Allow all access to compliance_log" ON public.compliance_log;

-- Same policies, production's names, and scoped `TO service_role` rather than
-- the default `PUBLIC` — which is what `USING (true)` with no TO clause means,
-- and includes `anon`.
DROP POLICY IF EXISTS "Service role full access on baskets"          ON public.baskets;
DROP POLICY IF EXISTS "Service role full access on signals"          ON public.signals;
DROP POLICY IF EXISTS "Service role full access on strategy_config"  ON public.strategy_config;
DROP POLICY IF EXISTS "Service role full access on surface_alerts"   ON public.surface_alerts;
DROP POLICY IF EXISTS "Service role full access on auto_trade_locks" ON public.auto_trade_locks;
DROP POLICY IF EXISTS "waitlist_insert_public"                       ON public.waitlist;
DROP POLICY IF EXISTS "waitlist_select_service_only"                 ON public.waitlist;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Create the policies production has and the migration set does not
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS baskets_service_role ON public.baskets;
CREATE POLICY baskets_service_role ON public.baskets
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Created only when absent, never dropped and recreated. This is a real tenant
-- isolation policy and production already has it with exactly this definition;
-- a drop/create pair would leave a window with no isolation on `baskets` if the
-- statement after the DROP ever failed. The service-role policies above are
-- `USING (true)` and carry no such risk, so they use the simpler form.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'baskets'
      AND policyname = 'baskets_user_isolation'
  ) THEN
    CREATE POLICY baskets_user_isolation ON public.baskets
      FOR ALL TO public
      USING (user_id IS NULL OR user_id = (auth.uid())::text)
      WITH CHECK (user_id IS NULL OR user_id = (auth.uid())::text);
  END IF;
END $$;

DROP POLICY IF EXISTS signals_service_role ON public.signals;
CREATE POLICY signals_service_role ON public.signals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS strategy_config_service_role ON public.strategy_config;
CREATE POLICY strategy_config_service_role ON public.strategy_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS surface_alerts_service_role ON public.surface_alerts;
CREATE POLICY surface_alerts_service_role ON public.surface_alerts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS weather_forecasts_service_role ON public.weather_forecasts;
CREATE POLICY weather_forecasts_service_role ON public.weather_forecasts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS weather_markets_cache_service_role ON public.weather_markets_cache;
CREATE POLICY weather_markets_cache_service_role ON public.weather_markets_cache
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS spread_history_read ON public.spread_history;
CREATE POLICY spread_history_read ON public.spread_history
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS backtest_recommendations_read ON public.backtest_recommendations;
CREATE POLICY backtest_recommendations_read ON public.backtest_recommendations
  FOR SELECT TO authenticated USING (true);

-- Platform-level compliance rows (user_id IS NULL) are readable by any signed-in
-- user; per-user rows stay behind compliance_user_isolation.
DROP POLICY IF EXISTS system_events_readable ON public.compliance_log;
CREATE POLICY system_events_readable ON public.compliance_log
  FOR SELECT TO authenticated USING (user_id IS NULL);

DROP POLICY IF EXISTS public_count ON public.waitlist;
CREATE POLICY public_count ON public.waitlist
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS public_insert ON public.waitlist;
CREATE POLICY public_insert ON public.waitlist
  FOR INSERT TO anon WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Constraints
-- ─────────────────────────────────────────────────────────────────────────────

-- The closed 14-value allowlist from 20260402000000 rejects `health_check_alert`,
-- which 20260726_alert_dedup_race.sql writes. Production replaced it with a
-- constraint that only polices rows in the `compliance` category.
ALTER TABLE public.compliance_log DROP CONSTRAINT IF EXISTS compliance_log_event_type_check;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_event_type_allowlist') THEN
    ALTER TABLE public.compliance_log ADD CONSTRAINT compliance_event_type_allowlist
      CHECK (category <> 'compliance' OR event_type = ANY (ARRAY[
        'order_submitted', 'order_filled', 'order_failed', 'order_cancelled',
        'risk_check_failed', 'risk_check_passed', 'trading_halted',
        'auth_rejected', 'api_error', 'strategy_auto_halted']));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'strategies_run_interval_positive') THEN
    ALTER TABLE public.strategies ADD CONSTRAINT strategies_run_interval_positive
      CHECK (run_interval_minutes IS NULL OR run_interval_minutes > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trades_resolution_check') THEN
    ALTER TABLE public.trades ADD CONSTRAINT trades_resolution_check
      CHECK (resolution = ANY (ARRAY['yes', 'no', 'void']) OR resolution IS NULL);
  END IF;

  -- Production carries this as a UNIQUE constraint; 20260423000000 created a bare
  -- unique index under the same name. Same guarantee, different catalog entry —
  -- swap the index for the constraint so a rebuild matches.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signals_ticker_source_unique') THEN
    DROP INDEX IF EXISTS public.signals_ticker_source_unique;
    ALTER TABLE public.signals ADD CONSTRAINT signals_ticker_source_unique UNIQUE (ticker, source);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Index names
--
-- 20260504120000 never reached these in production, so the indexes there were
-- created by hand under different names. Adopt production's names; leaving both
-- sets in the migration would create duplicate indexes on the next apply.
-- ─────────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS public.idx_memory_attribution_memory;
DROP INDEX IF EXISTS public.idx_memory_attribution_settled;
CREATE INDEX IF NOT EXISTS memory_attribution_memory_id_idx
  ON public.memory_attribution (memory_id);
CREATE INDEX IF NOT EXISTS memory_attribution_settled_at_idx
  ON public.memory_attribution (settled_at);
