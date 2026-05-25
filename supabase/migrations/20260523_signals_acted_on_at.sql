-- Track when a signal was consumed by auto-trade.
-- was_acted_on already existed (20260406_signal_surface_tables.sql) but was never written to.
-- acted_on_at records the timestamp for audit trail.
-- Partial index makes was_acted_on=false queries fast (the hot path in auto-trade).
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS acted_on_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_signals_was_acted_on
  ON public.signals (was_acted_on)
  WHERE was_acted_on = false;
