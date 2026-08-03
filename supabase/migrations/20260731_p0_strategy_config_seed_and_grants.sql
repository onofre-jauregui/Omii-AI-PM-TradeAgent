-- P0 production correctness: strategy_config lifecycle + grant hardening
-- (fix/p0-production-correctness, 2026-07-31)
--
-- 1. Every strategies row gets a strategy_config row, automatically.
--    auto-trade's kill switch (consecutive-failure halt) is gated on
--    `if (config)` — and nothing ever seeded config for per-user strategy
--    instances, so NO user strategy has ever been able to auto-halt, and all
--    their thresholds silently ran on hardcoded fallbacks. A trigger is the
--    root-cause fix: no insert path (onboarding, createInstance, chat tool,
--    future authoring UI) can forget it.
--
-- 2. Backfill config for the user strategies that already exist.
--
-- 3. Revoke anon/authenticated DML grants on the three service-managed tables.
--    RLS already default-denies them (service-role-only policies) — but the
--    broad grants left each table one accidental policy change away from
--    world-writable. Grants should express intent: these tables are
--    service-role surfaces.
--
-- 4. strategy_config owner policies: the service-role-only RLS (which
--    correctly closed the world-writable hole) also silently broke the ONE
--    legitimate client write — AgentPanel's per-strategy max_position_usd
--    upsert (AgentPanel.tsx savePositionSize, which never checks its error).
--    Restore it with owner-scoped policies joined through strategies
--    ownership; every other column stays service-role-only in practice
--    because the UI only writes max_position_usd.

-- ── 1. Auto-seed trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.seed_strategy_config_for_new_strategy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.strategy_config (strategy_id)
  VALUES (NEW.id)
  ON CONFLICT (strategy_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seed_strategy_config_on_insert ON public.strategies;
CREATE TRIGGER seed_strategy_config_on_insert
  AFTER INSERT ON public.strategies
  FOR EACH ROW
  EXECUTE FUNCTION public.seed_strategy_config_for_new_strategy();

-- ── 2. Backfill existing strategies without a config row ────────────────────
INSERT INTO public.strategy_config (strategy_id)
SELECT s.id
FROM public.strategies s
LEFT JOIN public.strategy_config c ON c.strategy_id = s.id
WHERE c.strategy_id IS NULL
ON CONFLICT (strategy_id) DO NOTHING;

-- ── 3. Revoke broad public grants on service-managed tables ─────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.signals, public.strategy_config, public.auto_trade_locks
  FROM anon, authenticated;
-- anon has no business reading the raw signal pool or the lock table either.
REVOKE SELECT ON public.auto_trade_locks FROM anon;

-- ── 4. Owner-scoped strategy_config access for the dashboard ────────────────
-- SELECT: a user may read config for strategies they own.
DROP POLICY IF EXISTS strategy_config_owner_select ON public.strategy_config;
CREATE POLICY strategy_config_owner_select ON public.strategy_config
  FOR SELECT TO authenticated
  USING (
    strategy_id IN (
      SELECT id FROM public.strategies WHERE user_id = auth.uid()::text
    )
  );

-- UPDATE: a user may tune config for strategies they own. (INSERT stays
-- service-role-only — the trigger in §1 guarantees the row exists, so the
-- client upsert always resolves to an UPDATE.)
DROP POLICY IF EXISTS strategy_config_owner_update ON public.strategy_config;
CREATE POLICY strategy_config_owner_update ON public.strategy_config
  FOR UPDATE TO authenticated
  USING (
    strategy_id IN (
      SELECT id FROM public.strategies WHERE user_id = auth.uid()::text
    )
  )
  WITH CHECK (
    strategy_id IN (
      SELECT id FROM public.strategies WHERE user_id = auth.uid()::text
    )
  );

-- Owner policies need the base table privileges back (RLS still scopes rows).
GRANT SELECT, UPDATE ON public.strategy_config TO authenticated;

-- ── 5. RLS drift assertion for health-check ─────────────────────────────────
-- One RLS-off table (weather_bucket_calibration, 2026-07-08) already slipped
-- through once. PostgREST can't read pg_catalog, so expose a service-role-only
-- RPC that health-check calls every hour and pages on any hit.
CREATE OR REPLACE FUNCTION public.rls_disabled_tables()
RETURNS TABLE(table_name text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT c.relrowsecurity
$$;

REVOKE ALL ON FUNCTION public.rls_disabled_tables() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rls_disabled_tables() TO service_role;
