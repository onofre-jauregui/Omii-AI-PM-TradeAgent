-- Lovable-era duplicate. strategies is already created by
-- 20260402100000_strategies_table.sql, which sorts earlier. Guarded rather than
-- deleted, for the same reason as 20260405165717.

-- strategies table
CREATE TABLE IF NOT EXISTS public.strategies (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true,
  mode TEXT NOT NULL DEFAULT 'paper',
  starting_balance NUMERIC NOT NULL DEFAULT 1000,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.strategies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all access to strategies" ON public.strategies;
CREATE POLICY "Allow all access to strategies" ON public.strategies FOR ALL USING (true) WITH CHECK (true);

-- Add missing columns to trades
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS ticker TEXT;
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS order_type TEXT;
