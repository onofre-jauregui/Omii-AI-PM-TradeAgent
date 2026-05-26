-- Add allocated_capital to risk_settings.
-- This is the hard cap on how much of the Kalshi balance the agent can
-- have deployed (open exposure) at any given time. The execute-basket
-- function checks open exposure + incoming order total against this cap
-- before placing any live order. Paper trades are not subject to this cap.
ALTER TABLE public.risk_settings
  ADD COLUMN IF NOT EXISTS allocated_capital NUMERIC NOT NULL DEFAULT 500;
