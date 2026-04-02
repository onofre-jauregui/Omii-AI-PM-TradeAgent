-- Upgrade schema for Kalshi event contracts trading
-- Adds: order management, compliance logging, risk tracking, API key storage

-- Add new columns to trades table for Kalshi-specific fields
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS ticker TEXT,
  ADD COLUMN IF NOT EXISTS order_id TEXT,
  ADD COLUMN IF NOT EXISTS order_type TEXT DEFAULT 'limit' CHECK (order_type IN ('limit', 'market')),
  ADD COLUMN IF NOT EXISTS time_in_force TEXT DEFAULT 'gtc' CHECK (time_in_force IN ('gtc', 'ioc', 'day')),
  ADD COLUMN IF NOT EXISTS expiration_ts TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS filled_price NUMERIC,
  ADD COLUMN IF NOT EXISTS filled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exchange TEXT DEFAULT 'kalshi' CHECK (exchange IN ('kalshi', 'paper'));

-- Update side constraint to support Kalshi's yes/no terminology
ALTER TABLE public.trades DROP CONSTRAINT IF EXISTS trades_side_check;
ALTER TABLE public.trades ADD CONSTRAINT trades_side_check CHECK (side IN ('yes', 'no'));

-- Update status to include more states
ALTER TABLE public.trades DROP CONSTRAINT IF EXISTS trades_status_check;
ALTER TABLE public.trades ADD CONSTRAINT trades_status_check
  CHECK (status IN ('pending', 'open', 'filled', 'partial', 'failed', 'cancelled', 'expired'));

-- Compliance / audit log table
CREATE TABLE IF NOT EXISTS public.compliance_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID REFERENCES public.trades(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'order_submitted', 'order_filled', 'order_cancelled', 'order_failed',
    'order_expired', 'risk_check_passed', 'risk_check_failed',
    'liquidity_fallback', 'position_limit_hit', 'daily_loss_limit_hit',
    'margin_check_passed', 'margin_check_failed', 'api_error', 'system_event'
  )),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.compliance_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to compliance_log" ON public.compliance_log
  FOR ALL USING (true) WITH CHECK (true);

-- Risk state tracking table
CREATE TABLE IF NOT EXISTS public.risk_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  daily_pnl NUMERIC NOT NULL DEFAULT 0,
  daily_trades INTEGER NOT NULL DEFAULT 0,
  open_position_count INTEGER NOT NULL DEFAULT 0,
  open_position_value NUMERIC NOT NULL DEFAULT 0,
  max_drawdown_today NUMERIC NOT NULL DEFAULT 0,
  peak_portfolio_value NUMERIC NOT NULL DEFAULT 0,
  is_trading_halted BOOLEAN NOT NULL DEFAULT false,
  halt_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(date)
);

ALTER TABLE public.risk_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to risk_state" ON public.risk_state
  FOR ALL USING (true) WITH CHECK (true);

-- Risk settings table (persisted configuration)
CREATE TABLE IF NOT EXISTS public.risk_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  max_daily_loss NUMERIC NOT NULL DEFAULT 500,
  max_drawdown_pct NUMERIC NOT NULL DEFAULT 20,
  max_position_size NUMERIC NOT NULL DEFAULT 500,
  max_open_positions INTEGER NOT NULL DEFAULT 10,
  auto_stop_loss BOOLEAN NOT NULL DEFAULT true,
  stop_loss_pct NUMERIC NOT NULL DEFAULT 15,
  default_order_type TEXT NOT NULL DEFAULT 'limit',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.risk_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to risk_settings" ON public.risk_settings
  FOR ALL USING (true) WITH CHECK (true);

-- Insert default risk settings
INSERT INTO public.risk_settings (max_daily_loss, max_drawdown_pct, max_position_size, max_open_positions)
VALUES (500, 20, 500, 10)
ON CONFLICT DO NOTHING;

-- API keys table (encrypted at rest by Supabase)
CREATE TABLE IF NOT EXISTS public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('kalshi', 'openrouter', 'openai', 'anthropic', 'google')),
  key_id TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  is_valid BOOLEAN DEFAULT true,
  last_validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider)
);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to api_keys" ON public.api_keys
  FOR ALL USING (true) WITH CHECK (true);

-- Positions view (computed from trades)
CREATE OR REPLACE VIEW public.open_positions AS
WITH filled_trades AS (
  SELECT
    ticker,
    market_id,
    market_question,
    side,
    action,
    filled_price,
    price,
    amount,
    strategy,
    mode,
    created_at
  FROM public.trades
  WHERE status = 'filled'
),
position_calc AS (
  SELECT
    COALESCE(ticker, market_id) AS ticker,
    market_id,
    MAX(market_question) AS market_question,
    side,
    MAX(strategy) AS strategy,
    MAX(mode) AS mode,
    SUM(CASE WHEN action = 'buy' THEN amount ELSE -amount END) AS net_contracts,
    SUM(CASE WHEN action = 'buy' THEN amount * COALESCE(filled_price, price) ELSE 0 END) /
      NULLIF(SUM(CASE WHEN action = 'buy' THEN amount ELSE 0 END), 0) AS avg_entry_price,
    SUM(CASE WHEN action = 'buy' THEN amount * COALESCE(filled_price, price) ELSE -amount * COALESCE(filled_price, price) END) AS cost_basis,
    MIN(created_at) AS opened_at,
    MAX(created_at) AS last_trade_at
  FROM filled_trades
  GROUP BY COALESCE(ticker, market_id), market_id, side
)
SELECT * FROM position_calc WHERE net_contracts > 0;

-- Enable realtime on new tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.compliance_log;
ALTER PUBLICATION supabase_realtime ADD TABLE public.risk_state;
