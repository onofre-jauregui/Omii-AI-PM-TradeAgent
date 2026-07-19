-- Gap 1: Add RLS to tables that were missing it.
--
-- memory_attribution is a join table (trade_id → memory_id). No direct user_id column,
-- so isolation is enforced via subquery: the row belongs to the user who owns the trade.
--
-- weather_forecasts, weather_markets_cache, kalshi_markets_cache are global reference/cache
-- tables — cross-user reads are fine, but enabling RLS with an explicit public-read policy
-- makes that intent clear and prevents accidental write access from the client.

-- ── memory_attribution ──────────────────────────────────────────────────────
ALTER TABLE public.memory_attribution ENABLE ROW LEVEL SECURITY;

-- Read: only rows whose trade_id belongs to the current user.
CREATE POLICY "memory_attribution_user_read"
  ON public.memory_attribution
  FOR SELECT
  USING (
    trade_id IN (
      SELECT id FROM public.trades WHERE user_id = auth.uid()::text
    )
  );

-- Write (INSERT/UPDATE/DELETE): service role only — auto-reflect handles this server-side.
-- No client-facing write policy means anon/authenticated roles cannot mutate these rows.

-- ── weather_forecasts (global cache — public read, no user data) ─────────────
ALTER TABLE public.weather_forecasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "weather_forecasts_public_read"
  ON public.weather_forecasts
  FOR SELECT
  TO authenticated
  USING (true);

-- ── weather_markets_cache (global cache) ────────────────────────────────────
ALTER TABLE public.weather_markets_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "weather_markets_cache_public_read"
  ON public.weather_markets_cache
  FOR SELECT
  TO authenticated
  USING (true);

-- ── kalshi_markets_cache (global cache) ─────────────────────────────────────
ALTER TABLE public.kalshi_markets_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "kalshi_markets_cache_public_read"
  ON public.kalshi_markets_cache
  FOR SELECT
  TO authenticated
  USING (true);
