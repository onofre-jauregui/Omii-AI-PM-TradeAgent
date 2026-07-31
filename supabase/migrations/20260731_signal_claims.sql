-- P1: per-(signal, strategy) consumption claims.
--
-- signals.was_acted_on is a GLOBAL boolean on tenant-shared rows: the first
-- strategy to fill a signal consumed it for every other user, permanently —
-- and strategies iterate in .order("id"), so the alphabetically-first user won
-- every cycle. Invisible with 3 users; a first-come-first-served queue at 20.
--
-- Claims scope consumption to the strategy instance: the same platform signal
-- can be traded once per strategy (no per-strategy re-entry across cycles),
-- while different users' strategies each get their own shot at it.
-- was_acted_on is still WRITTEN for analytics/back-compat, but the trading
-- path no longer filters on it.

CREATE TABLE IF NOT EXISTS public.signal_claims (
  signal_id   UUID NOT NULL REFERENCES public.signals(id) ON DELETE CASCADE,
  strategy_id TEXT NOT NULL,
  user_id     TEXT,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (signal_id, strategy_id)
);

-- Trading path looks up "what has THIS strategy already claimed recently".
CREATE INDEX IF NOT EXISTS signal_claims_strategy_recent_idx
  ON public.signal_claims (strategy_id, claimed_at DESC);

ALTER TABLE public.signal_claims ENABLE ROW LEVEL SECURITY;

-- Service-role writes only; owners may read their own strategies' claims.
DROP POLICY IF EXISTS signal_claims_service_role ON public.signal_claims;
CREATE POLICY signal_claims_service_role ON public.signal_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS signal_claims_owner_select ON public.signal_claims;
CREATE POLICY signal_claims_owner_select ON public.signal_claims
  FOR SELECT TO authenticated
  USING (user_id = auth.uid()::text);

-- Backfill: every signal already marked acted-on becomes a claim for the
-- strategy that traded it, so historical consumption survives the cutover and
-- no strategy re-trades a signal it already acted on. trades.source_signal_id
-- is the linkage where it exists.
INSERT INTO public.signal_claims (signal_id, strategy_id, user_id, claimed_at)
SELECT t.source_signal_id, t.strategy_id, t.user_id, COALESCE(s.acted_on_at, t.created_at)
FROM public.trades t
JOIN public.signals s ON s.id = t.source_signal_id
WHERE t.source_signal_id IS NOT NULL AND t.strategy_id IS NOT NULL
ON CONFLICT (signal_id, strategy_id) DO NOTHING;
