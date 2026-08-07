-- Persist strategies to the database with performance tracking

CREATE TABLE IF NOT EXISTS public.strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT false,
  mode TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper', 'live')),
  starting_balance NUMERIC NOT NULL DEFAULT 1000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.strategies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all access to strategies" ON public.strategies;
CREATE POLICY "Allow all access to strategies" ON public.strategies
  FOR ALL USING (true) WITH CHECK (true);

-- Seed default strategies
INSERT INTO public.strategies (id, name, description, instructions, active) VALUES
  ('S-001', 'Momentum', 'Buy when price trends upward with volume confirmation', 'When analyzing markets, look for sustained directional price movement over the last 24-48 hours. Confirm with increasing volume. Enter positions when momentum is strong and exit when volume starts declining. Use a 5% trailing stop-loss. Favor markets with >$100K daily volume.', true),
  ('S-002', 'Mean Reversion', 'Trade against extreme price moves expecting reversion', 'Identify markets where the YES/NO price has moved more than 15% in 24 hours without a clear fundamental catalyst. Take contrarian positions expecting prices to revert to the mean. Set take-profit at 50% of the deviation and stop-loss at 1.5x the deviation. Avoid markets near resolution dates.', false),
  ('S-003', 'Cross-Market Arb', 'Exploit price differences across correlated markets', 'Look for correlated prediction markets where the combined probabilities create an arbitrage opportunity. For example, if Market A (YES) + Market B (NO) costs less than $1 and the outcomes are mutually exclusive, buy both. Also look for YES + NO prices within the same market that don''t sum to exactly $1.', true),
  ('S-004', 'AI Sentiment', 'Use AI to analyze news & social sentiment for signals', 'Analyze recent news headlines, social media sentiment, and expert opinions related to each market''s underlying question. Score sentiment from -1 (very bearish) to +1 (very bullish). Trade when sentiment diverges from current market price by more than 20%. Weight recent news more heavily than older information.', false)
ON CONFLICT (id) DO NOTHING;

-- Add strategy_id foreign key to trades (nullable, for backward compat)
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS strategy_id TEXT REFERENCES public.strategies(id) ON DELETE SET NULL;

-- Strategy snapshots: periodic performance recording for charting
CREATE TABLE IF NOT EXISTS public.strategy_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id TEXT NOT NULL REFERENCES public.strategies(id) ON DELETE CASCADE,
  balance NUMERIC NOT NULL,
  total_pnl NUMERIC NOT NULL DEFAULT 0,
  total_trades INTEGER NOT NULL DEFAULT 0,
  winning_trades INTEGER NOT NULL DEFAULT 0,
  losing_trades INTEGER NOT NULL DEFAULT 0,
  open_positions INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.strategy_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all access to strategy_snapshots" ON public.strategy_snapshots;
CREATE POLICY "Allow all access to strategy_snapshots" ON public.strategy_snapshots
  FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_strategy_snapshots_strategy_time
  ON public.strategy_snapshots (strategy_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_trades_strategy_id
  ON public.trades (strategy_id);

DO $pub$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.strategies;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$pub$;
DO $pub$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.strategy_snapshots;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$pub$;
