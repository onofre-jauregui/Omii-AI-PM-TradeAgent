-- Drawdown gear ladder: persist each strategy's current de-levering state.
--
-- auto-reflect already walks every strategy's rolling settled-trade window once
-- an hour to compute Sharpe, drawdown and hit rate. It now also writes the gear
-- that window implies, so auto-trade reads one column per strategy instead of
-- re-querying trade history on every leg of every 5-minute tick.
--
-- The trade-off is deliberate: the gear moves hourly rather than per-trade. For
-- a position-size governor that is the right granularity — a per-trade gear
-- would chase noise, and the hourly cadence already matches how suspension
-- decisions are made.
--
-- Both columns are advisory. A NULL current_gear means "never evaluated" and
-- callers treat it as 1.0 (full size), so this migration cannot itself change
-- any strategy's behaviour until auto-reflect populates it.

ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS current_gear NUMERIC NOT NULL DEFAULT 1.0;

ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS current_drawdown_pct NUMERIC;

-- Gear is a multiplier on position size. 0 is reserved for "stopped at the
-- equity floor"; 1.0 is full size. Anything outside that range is a bug in the
-- writer, and a strategy sizing off a bad multiplier trades real money wrong —
-- so the constraint is enforced rather than assumed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'strategies_current_gear_range'
      AND conrelid = 'public.strategies'::regclass
  ) THEN
    ALTER TABLE public.strategies
      ADD CONSTRAINT strategies_current_gear_range
      CHECK (current_gear >= 0 AND current_gear <= 1);
  END IF;
END
$$;

COMMENT ON COLUMN public.strategies.current_gear IS
  'Position-size multiplier from the drawdown ladder (computeDrawdownGear). 1.0 = full size, 0.10 = minimum gear, 0 = stopped at the equity floor. Written hourly by auto-reflect, read by auto-trade.';

COMMENT ON COLUMN public.strategies.current_drawdown_pct IS
  'Current equity below peak as a fraction (0.20 = 20% down), from computeCurrentDrawdownPct. Observability for the gear above; NULL until first evaluated.';
