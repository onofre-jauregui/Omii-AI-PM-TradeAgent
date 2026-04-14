-- ============================================================================
-- 20260414_security_and_billing.sql
--
-- Critical SaaS-blocker fixes + new feature support:
--
--  1. SECURITY: replace plaintext encrypted_secret with AES-GCM ciphertext
--     stored as base64 TEXT. Edge functions encrypt on write and decrypt on
--     read using a master key from API_KEY_ENCRYPTION_KEY env var.
--
--  2. MULTI-TENANCY: fix api_keys constraints. Drop global UNIQUE(provider),
--     add UNIQUE(user_id, provider). user_id is nullable so legacy single-user
--     mode keeps working (NULL user_id behaves as "default tenant").
--
--  3. PER-USER RISK: risk_settings and risk_state now key on user_id so every
--     user has their own limits and daily P&L state.
--
--  4. STRIPE BILLING: new subscriptions and stripe_events tables. Subscription
--     state is the source of truth for whether a user can use the agent.
--
--  5. WEATHER STRATEGY: new weather_forecasts and weather_markets_cache tables
--     to support the S-005 weather strategy without hitting NWS on every tick.
--
--  6. STRATEGY KILL SWITCH: disable S-003 Economic Consensus by default,
--     because the Federal Reserve research paper "Kalshi and the Rise of
--     Macro Markets" (2026) shows Kalshi macro markets are efficient and
--     liquidity is provided by Susquehanna, Citadel, Two Sigma. Trading
--     against them is contraindicated by published evidence.
--
-- ============================================================================

-- ── 1. SECURITY: api_keys encryption columns ────────────────────────────────
-- The existing 'encrypted_secret' column is plaintext and misnamed. We add
-- new columns for actual ciphertext and IV, and let edge functions use them
-- via the encryption helper module.

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS secret_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS secret_iv TEXT;

COMMENT ON COLUMN public.api_keys.secret_ciphertext IS
  'AES-GCM ciphertext, base64-encoded. Encrypted with master key from API_KEY_ENCRYPTION_KEY env var. NEVER read this column without going through the encryption helper.';

COMMENT ON COLUMN public.api_keys.secret_iv IS
  'AES-GCM initialization vector, base64-encoded. Unique per row.';

COMMENT ON COLUMN public.api_keys.encrypted_secret IS
  'DEPRECATED: stores plaintext despite misleading name. Do not use for new writes. Migrate any rows to secret_ciphertext + secret_iv. Will be dropped in a future migration once all rows are migrated.';

-- ── 2. MULTI-TENANCY: api_keys per-user uniqueness ─────────────────────────
-- Drop any leftover global UNIQUE(provider) constraints (may already be gone
-- from the multi-tenancy migration but be defensive).
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_provider_key;
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_provider_key1;
DROP INDEX IF EXISTS api_keys_provider_key;

-- Add per-user composite uniqueness. A NULL user_id behaves as "default
-- tenant" and there can be at most one such row per provider.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_user_provider_unique
  ON public.api_keys (COALESCE(user_id, ''), provider);

-- ── 3. PER-USER RISK STATE & SETTINGS ───────────────────────────────────────
-- risk_settings was previously a singleton row. Make user_id nullable but
-- enforce uniqueness per user so every user has exactly one settings row.
CREATE UNIQUE INDEX IF NOT EXISTS risk_settings_user_unique
  ON public.risk_settings (COALESCE(user_id, ''));

-- risk_state is per-day; make it per-(user, date) so daily P&L is isolated.
ALTER TABLE public.risk_state DROP CONSTRAINT IF EXISTS risk_state_date_key;
DROP INDEX IF EXISTS risk_state_date_key;

CREATE UNIQUE INDEX IF NOT EXISTS risk_state_user_date_unique
  ON public.risk_state (COALESCE(user_id, ''), date);

-- ── 4. STRIPE BILLING ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id TEXT,
  tier TEXT NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'starter', 'pro', 'prop')),
  status TEXT NOT NULL DEFAULT 'inactive'
    CHECK (status IN ('inactive', 'trialing', 'active', 'past_due', 'canceled', 'unpaid')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  -- Per-tier usage limits (nullable means "tier default applies")
  max_trades_per_day INTEGER,
  max_open_positions INTEGER,
  max_position_usd NUMERIC,
  max_markets_watched INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON public.subscriptions (user_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON public.subscriptions (status);

-- Idempotent stripe webhook event log. Used to dedupe webhook deliveries
-- by event id and provide an audit trail for billing reconciliation.
CREATE TABLE IF NOT EXISTS public.stripe_events (
  id TEXT PRIMARY KEY,           -- the stripe event id (evt_...)
  type TEXT NOT NULL,            -- the stripe event type
  user_id TEXT,                  -- resolved user_id if known
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'error')),
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS stripe_events_type_idx ON public.stripe_events (type);
CREATE INDEX IF NOT EXISTS stripe_events_user_idx ON public.stripe_events (user_id);

-- RLS: subscriptions are user-scoped, stripe_events are admin-only
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscriptions_user_isolation" ON public.subscriptions
  FOR ALL USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- stripe_events has no user-facing policy; only service role can read/write
CREATE POLICY "stripe_events_service_only" ON public.stripe_events
  FOR ALL USING (false) WITH CHECK (false);

-- ── 5. WEATHER STRATEGY (S-005) ─────────────────────────────────────────────
-- Cache for NWS / GFS forecasts so we don't pound NOAA on every tick.

CREATE TABLE IF NOT EXISTS public.weather_forecasts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  location TEXT NOT NULL,           -- e.g. 'NYC', 'CHI', 'MIA', 'AUS'
  forecast_date DATE NOT NULL,      -- the date the forecast is FOR
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL,             -- 'nws_grid', 'gfs_ensemble', etc.
  -- Probabilistic distribution over high-temperature buckets, stored as
  -- a JSON map: { "55-59": 0.10, "60-64": 0.35, ... }
  high_temp_distribution JSONB NOT NULL,
  -- Convenience fields for fast filtering
  expected_high NUMERIC,
  std_dev NUMERIC,
  raw_payload JSONB                 -- full raw payload for debugging
);

CREATE INDEX IF NOT EXISTS weather_forecasts_location_date_idx
  ON public.weather_forecasts (location, forecast_date DESC, fetched_at DESC);

-- A daily snapshot of currently-listed Kalshi weather markets so we can
-- compute edge without re-fetching markets every tick.
CREATE TABLE IF NOT EXISTS public.weather_markets_cache (
  ticker TEXT PRIMARY KEY,
  location TEXT NOT NULL,
  forecast_date DATE NOT NULL,
  bucket_low NUMERIC NOT NULL,      -- lower bound of temperature bucket
  bucket_high NUMERIC NOT NULL,     -- upper bound of temperature bucket
  yes_bid NUMERIC,
  yes_ask NUMERIC,
  last_price NUMERIC,
  market_question TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS weather_markets_cache_location_date_idx
  ON public.weather_markets_cache (location, forecast_date);

-- ── 6. DISABLE S-003 ECONOMIC CONSENSUS BY DEFAULT ──────────────────────────
-- Per Federal Reserve paper "Kalshi and the Rise of Macro Markets" (2026),
-- Kalshi macro contracts are efficiently priced (perfect FOMC forecast record,
-- beats Bloomberg consensus on headline CPI). Liquidity is provided by
-- Susquehanna, Citadel, Two Sigma. Trading against them is contraindicated.
-- Strategy can be re-enabled manually via SQL or UI if a specific edge thesis
-- is identified for a sub-market.

UPDATE public.strategy_config
SET is_halted = true,
    halt_reason = 'Disabled by 20260414 migration: Federal Reserve research shows Kalshi macro markets are efficient. Trading against Susquehanna/Citadel/Two Sigma is contraindicated. Re-enable only with a specific named edge thesis.',
    updated_at = now()
WHERE strategy_id = 'S-003';

-- Also mark the strategies row inactive if it exists, so the auto-trade
-- loop skips it entirely.
UPDATE public.strategies
SET active = false
WHERE id = 'S-003';
