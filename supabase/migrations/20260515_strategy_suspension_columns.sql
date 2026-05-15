-- Add missing columns required by auto-reflect strategy health monitor.
-- suspended_until already exists (20260427_suspended_until.sql).
-- Without these, auto-reflect fails on every run and cannot suspend/resume strategies.
ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT,
  ADD COLUMN IF NOT EXISTS expected_hit_rate NUMERIC DEFAULT 0.50,
  ADD COLUMN IF NOT EXISTS max_acceptable_drawdown NUMERIC DEFAULT 0.25;
