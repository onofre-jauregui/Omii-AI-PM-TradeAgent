-- Add suspended_until to strategies so auto-reflect can temporarily suspend
-- a strategy after consecutive losses and auto-resume it later.
ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS suspended_until timestamptz;

-- Index for the auto-resume query (checks if suspension has expired)
CREATE INDEX IF NOT EXISTS idx_strategies_suspended_until
  ON public.strategies (suspended_until)
  WHERE suspended_until IS NOT NULL;
