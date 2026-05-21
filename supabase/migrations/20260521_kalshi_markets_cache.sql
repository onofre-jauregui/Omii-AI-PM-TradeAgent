-- kalshi_markets_cache: single source of truth for Kalshi market data.
-- market-data-fetcher writes here every 5 min using authenticated requests.
-- All consumers (surface-scanner, signal-generator, weather-signal) read here
-- instead of hitting Kalshi directly — eliminates 429s from parallel polling.

CREATE TABLE IF NOT EXISTS public.kalshi_markets_cache (
  market_ticker TEXT        NOT NULL PRIMARY KEY,
  series_ticker TEXT        NOT NULL,
  market_data   JSONB       NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kalshi_markets_cache_series_idx
  ON public.kalshi_markets_cache (series_ticker);

CREATE INDEX IF NOT EXISTS kalshi_markets_cache_fetched_at_idx
  ON public.kalshi_markets_cache (fetched_at);

-- Register market-data-fetcher cron: every 5 minutes (same cadence as surface-scanner,
-- so surface-scanner data is never more than one cycle old when it reads the cache).
SELECT cron.schedule(
  'market-data-fetcher-cron',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL')
               || '/functions/v1/market-data-fetcher',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body    := '{}'::jsonb
  );
  $$
) ON CONFLICT (jobname) DO UPDATE SET schedule = excluded.schedule;
