-- Tighten RLS: remove user_id IS NULL escape hatch on user-facing tables.
-- Service role bypasses RLS entirely, so edge functions are unaffected.
-- Rows with user_id = NULL become invisible to all frontend queries (correct —
-- system/legacy rows should only be accessed by service role).

-- ── trades ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "trades_user_isolation" ON public.trades;
CREATE POLICY "trades_user_isolation" ON public.trades
  FOR ALL USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- ── strategies ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "strategies_user_isolation" ON public.strategies;
CREATE POLICY "strategies_user_isolation" ON public.strategies
  FOR ALL USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- ── compliance_log ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "compliance_user_isolation" ON public.compliance_log;
CREATE POLICY "compliance_user_isolation" ON public.compliance_log
  FOR ALL USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- ── risk_state ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "risk_state_user_isolation" ON public.risk_state;
CREATE POLICY "risk_state_user_isolation" ON public.risk_state
  FOR ALL USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- ── risk_settings ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "risk_settings_user_isolation" ON public.risk_settings;
CREATE POLICY "risk_settings_user_isolation" ON public.risk_settings
  FOR ALL USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- ── api_keys ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "api_keys_user_isolation" ON public.api_keys;
CREATE POLICY "api_keys_user_isolation" ON public.api_keys
  FOR ALL USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- ── strategy_snapshots ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "snapshots_user_isolation" ON public.strategy_snapshots;
CREATE POLICY "snapshots_user_isolation" ON public.strategy_snapshots
  FOR ALL USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- ── agent_memory ──────────────────────────────────────────────────────────────
-- agent_memory uses integer user_id; keep null escape only here since
-- platform-wide memories (user_id = NULL) are intentionally shared read-only.
-- No change to agent_memory policy.
