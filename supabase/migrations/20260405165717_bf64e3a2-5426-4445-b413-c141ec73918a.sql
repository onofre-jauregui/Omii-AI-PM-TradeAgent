-- Lovable-era duplicate. api_keys, compliance_log and risk_settings are already
-- created by 20260402000000_kalshi_upgrade.sql, which sorts earlier, so every
-- statement below re-creates something that already exists. Guarded rather than
-- deleted: this filename is recorded in production's migration history, and
-- removing it would make the recorded history and the directory disagree.

-- api_keys table for storing provider API credentials
CREATE TABLE IF NOT EXISTS public.api_keys (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL DEFAULT '',
  encrypted_secret TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- compliance_log table for audit trail
CREATE TABLE IF NOT EXISTS public.compliance_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trade_id TEXT,
  event_type TEXT NOT NULL DEFAULT 'info',
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL DEFAULT '',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- risk_settings table (singleton row for risk config)
CREATE TABLE IF NOT EXISTS public.risk_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  max_daily_loss NUMERIC NOT NULL DEFAULT 500,
  max_drawdown_pct NUMERIC NOT NULL DEFAULT 20,
  max_position_size NUMERIC NOT NULL DEFAULT 500,
  max_open_positions INTEGER NOT NULL DEFAULT 10,
  auto_stop_loss BOOLEAN NOT NULL DEFAULT true,
  stop_loss_pct NUMERIC NOT NULL DEFAULT 15,
  default_order_type TEXT NOT NULL DEFAULT 'limit',
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add missing columns to trades table
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS strategy_id TEXT;
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS filled_price NUMERIC;

-- Enable realtime for compliance_log
DO $$
BEGIN
  DO $pub$
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.compliance_log;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END
  $pub$;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

-- Disable RLS on these tables for now (no auth enforced)
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_settings ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated + anon access (auth is disabled in app currently)
DROP POLICY IF EXISTS "Allow all access to api_keys" ON public.api_keys;
CREATE POLICY "Allow all access to api_keys" ON public.api_keys FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all access to compliance_log" ON public.compliance_log;
CREATE POLICY "Allow all access to compliance_log" ON public.compliance_log FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all access to risk_settings" ON public.risk_settings;
CREATE POLICY "Allow all access to risk_settings" ON public.risk_settings FOR ALL USING (true) WITH CHECK (true);
