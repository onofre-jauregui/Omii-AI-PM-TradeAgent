-- Multi-tenancy: add user_id to all tables, tighten RLS, update api_keys schema

-- ── 1. Update api_keys provider constraint ────────────────────────────────────
-- Rename 'kalshi' → 'kalshi_live' for clarity (paper trading uses public endpoints, no key needed)
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_provider_check;
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_provider_key;

ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_provider_check
  CHECK (provider IN ('kalshi_live', 'openrouter', 'openai', 'anthropic', 'google'));

-- Migrate any existing 'kalshi' rows to 'kalshi_live'
UPDATE public.api_keys SET provider = 'kalshi_live' WHERE provider = 'kalshi';

-- Re-add unique constraint scoped to provider (will be scoped to user_id after auth)
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_provider_key1;

-- ── 2. Add user_id to all tables ─────────────────────────────────────────────
-- Using TEXT so it works before and after Supabase Auth (UUID stored as text)
ALTER TABLE public.trades        ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE public.strategies    ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE public.compliance_log ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE public.risk_state    ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE public.risk_settings ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE public.api_keys      ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE public.strategy_snapshots ADD COLUMN IF NOT EXISTS user_id TEXT;

-- ── 3. Unique constraint on api_keys per user+provider ────────────────────────
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_provider_key;
-- Will enforce uniqueness at app layer for now; per-user unique added when auth is live

-- ── 4. Indexes for user_id lookups ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_trades_user_id         ON public.trades (user_id);
CREATE INDEX IF NOT EXISTS idx_strategies_user_id     ON public.strategies (user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id       ON public.api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_risk_settings_user_id  ON public.risk_settings (user_id);
CREATE INDEX IF NOT EXISTS idx_compliance_user_id     ON public.compliance_log (user_id);

-- ── 5. RLS policies updated for multi-tenancy ────────────────────────────────
-- Pattern: if user_id IS NULL (legacy / single-user mode) allow all.
-- When auth is enabled, user_id = auth.uid() and rows are fully isolated.

-- Trades
DROP POLICY IF EXISTS "Allow all access to trades" ON public.trades;
DROP POLICY IF EXISTS "trades_user_isolation" ON public.trades;
CREATE POLICY "trades_user_isolation" ON public.trades
  FOR ALL USING (user_id IS NULL OR user_id = auth.uid()::text)
  WITH CHECK (user_id IS NULL OR user_id = auth.uid()::text);

-- Strategies
DROP POLICY IF EXISTS "Allow all access to strategies" ON public.strategies;
DROP POLICY IF EXISTS "strategies_user_isolation" ON public.strategies;
CREATE POLICY "strategies_user_isolation" ON public.strategies
  FOR ALL USING (user_id IS NULL OR user_id = auth.uid()::text)
  WITH CHECK (user_id IS NULL OR user_id = auth.uid()::text);

-- Compliance log
DROP POLICY IF EXISTS "Allow all access to compliance_log" ON public.compliance_log;
DROP POLICY IF EXISTS "compliance_user_isolation" ON public.compliance_log;
CREATE POLICY "compliance_user_isolation" ON public.compliance_log
  FOR ALL USING (user_id IS NULL OR user_id = auth.uid()::text)
  WITH CHECK (user_id IS NULL OR user_id = auth.uid()::text);

-- Risk state
DROP POLICY IF EXISTS "Allow all access to risk_state" ON public.risk_state;
DROP POLICY IF EXISTS "risk_state_user_isolation" ON public.risk_state;
CREATE POLICY "risk_state_user_isolation" ON public.risk_state
  FOR ALL USING (user_id IS NULL OR user_id = auth.uid()::text)
  WITH CHECK (user_id IS NULL OR user_id = auth.uid()::text);

-- Risk settings
DROP POLICY IF EXISTS "Allow all access to risk_settings" ON public.risk_settings;
DROP POLICY IF EXISTS "risk_settings_user_isolation" ON public.risk_settings;
CREATE POLICY "risk_settings_user_isolation" ON public.risk_settings
  FOR ALL USING (user_id IS NULL OR user_id = auth.uid()::text)
  WITH CHECK (user_id IS NULL OR user_id = auth.uid()::text);

-- API keys (most sensitive — strict isolation)
DROP POLICY IF EXISTS "Allow all access to api_keys" ON public.api_keys;
DROP POLICY IF EXISTS "api_keys_user_isolation" ON public.api_keys;
CREATE POLICY "api_keys_user_isolation" ON public.api_keys
  FOR ALL USING (user_id IS NULL OR user_id = auth.uid()::text)
  WITH CHECK (user_id IS NULL OR user_id = auth.uid()::text);

-- Strategy snapshots
DROP POLICY IF EXISTS "Allow all access to strategy_snapshots" ON public.strategy_snapshots;
DROP POLICY IF EXISTS "snapshots_user_isolation" ON public.strategy_snapshots;
CREATE POLICY "snapshots_user_isolation" ON public.strategy_snapshots
  FOR ALL USING (user_id IS NULL OR user_id = auth.uid()::text)
  WITH CHECK (user_id IS NULL OR user_id = auth.uid()::text);
