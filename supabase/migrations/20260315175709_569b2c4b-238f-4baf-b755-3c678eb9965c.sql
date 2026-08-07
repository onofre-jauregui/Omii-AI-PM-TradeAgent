
CREATE TABLE IF NOT EXISTS public.trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id TEXT NOT NULL,
  market_question TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('yes', 'no')),
  action TEXT NOT NULL CHECK (action IN ('buy', 'sell')),
  price NUMERIC NOT NULL,
  amount NUMERIC NOT NULL,
  strategy TEXT,
  mode TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper', 'live')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'filled', 'failed', 'cancelled')),
  pnl NUMERIC DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;

-- Public access for now since no auth is implemented yet
DROP POLICY IF EXISTS "Allow all access to trades" ON public.trades;
CREATE POLICY "Allow all access to trades" ON public.trades
  FOR ALL USING (true) WITH CHECK (true);

DO $pub$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.trades;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$pub$;
