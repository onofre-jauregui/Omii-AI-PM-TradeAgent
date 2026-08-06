-- NOTE (2026-08-06): each cron.schedule() call below used to be closed by a
-- trailing upsert clause. That clause belongs to INSERT, not SELECT, so it was
-- invalid SQL and this file could never apply cleanly to any database, Supabase
-- included — it was recorded as applied without ever running to completion.
-- pg_cron's schedule() already replaces a job of the same name, so removing the
-- clause preserves the intent exactly. Found by scripts/rehearse-migrations.sh.

-- ============================================================================
-- 20260415_paper_trading_pipeline.sql
--
-- Resolves all blockers to running all four active strategies in paper mode:
--
--  1. SIGNALS TABLE: add missing columns that signal-generator and
--     weather-signal write but the original schema didn't have.
--
--  2. TRADES TABLE: add settled_at + resolution columns needed by auto-settle.
--
--  3. SETTLEMENT VIEW: create agent_trades_pending_resolution — the view
--     auto-settle reads to find paper trades awaiting settlement.
--
--  4. S-005 STRATEGY: seed strategies + strategy_config rows for the
--     Weather Edge strategy so auto-trade includes it in each run.
--
--  5. CRON JOBS: schedule weather-signal (every 30 min) and auto-settle
--     (every 10 min) — the two pipeline steps that had no schedule.
--
-- Safe to re-run: all DDL uses IF NOT EXISTS / ON CONFLICT DO NOTHING.
-- ============================================================================

-- ── 1. SIGNALS TABLE — missing columns ──────────────────────────────────────
-- signal-generator inserts yes_bid/yes_ask/no_bid/no_ask/edge_cents/source.
-- weather-signal inserts true_probability/implied_probability/metadata.
-- auto-trade S-002 and S-004 read yes_bid/yes_ask/no_ask.
-- auto-trade S-005 filters on source = 'weather_signal_s005'.

ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS yes_bid       integer,
  ADD COLUMN IF NOT EXISTS yes_ask       integer,
  ADD COLUMN IF NOT EXISTS no_bid        integer,
  ADD COLUMN IF NOT EXISTS no_ask        integer,
  ADD COLUMN IF NOT EXISTS edge_cents    numeric,   -- numeric, not integer: matches production
  ADD COLUMN IF NOT EXISTS source        text,
  ADD COLUMN IF NOT EXISTS true_probability  numeric(6,4),
  ADD COLUMN IF NOT EXISTS implied_probability numeric(6,4),
  ADD COLUMN IF NOT EXISTS metadata      jsonb DEFAULT '{}'::jsonb;

-- Indexes used by auto-trade strategy filters
CREATE INDEX IF NOT EXISTS signals_source_created_idx
  ON public.signals (source, created_at DESC);

CREATE INDEX IF NOT EXISTS signals_edge_cents_idx
  ON public.signals (edge_cents DESC);

-- ── 2. TRADES TABLE — settlement columns ────────────────────────────────────
-- auto-settle writes these after a market resolves.

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS settled_at  timestamptz,
  ADD COLUMN IF NOT EXISTS resolution  text;  -- 'yes' | 'no' | 'void'

-- ── 3. SETTLEMENT VIEW ───────────────────────────────────────────────────────
-- auto-settle reads from agent_trades_pending_resolution to find unsettled
-- paper trades. Filters to filled buy trades with no settled_at yet.

DROP VIEW IF EXISTS public.agent_trades_pending_resolution CASCADE;
CREATE VIEW public.agent_trades_pending_resolution AS
SELECT
  ticker,
  COUNT(*)                         AS trades_pending,
  ARRAY_AGG(id::text ORDER BY created_at) AS trade_ids,
  MIN(created_at)                  AS earliest_entry
FROM public.trades
WHERE
  mode       = 'paper'
  AND status = 'filled'
  AND action = 'buy'
  AND settled_at IS NULL
  AND ticker IS NOT NULL
GROUP BY ticker;

COMMENT ON VIEW public.agent_trades_pending_resolution IS
  'Paper trades that have been filled but not yet settled against a Kalshi outcome. Read by auto-settle every 10 minutes.';

-- ── 4. S-005 STRATEGY ────────────────────────────────────────────────────────
-- Weather Edge is the only strategy with a quantitative model behind it
-- (NWS forecast probability vs Kalshi market price). It needs rows in both
-- tables before auto-trade will include it in each run.

INSERT INTO public.strategies (id, name, description, instructions, active, mode, starting_balance)
VALUES (
  'S-005',
  'Weather Edge',
  'Exploits probability gaps between NWS hourly forecast distributions and live Kalshi daily high-temperature market prices. Pure quantitative strategy — no LLM directional reasoning. The LLM acts only as a safety gate to catch obvious errors (resolved markets, city mismatch, missing data).',
  E'Quantitative strategy. Edge comes from comparing NWS forecast distributions to Kalshi weather market prices. Run weather-signal first to generate signals, then auto-trade picks them up via source=weather_signal_s005. The LLM should QUALIFY unless the market is already settled, the ticker does not match the forecast city, or input data is clearly missing.',
  true,
  'paper',
  500
)
ON CONFLICT (id) DO UPDATE SET
  active     = true,
  mode       = 'paper',
  updated_at = now();

INSERT INTO public.strategy_config
  (strategy_id, min_edge_cents, min_liquidity_score, min_composite_score,
   max_position_usd, min_position_usd, max_legs, basket_timeout_seconds,
   min_post_fill_edge_cents, min_days_to_close, max_days_to_close,
   max_consecutive_failures)
VALUES
  ('S-005', 8, 0.2, 0.3, 30, 5, 1, 0, 0, 0, 2, 5)
ON CONFLICT (strategy_id) DO NOTHING;

-- ── 5. CRON JOBS ─────────────────────────────────────────────────────────────
-- weather-signal: every 30 minutes. Fetches NWS forecasts, computes edge
-- vs Kalshi weather market prices, writes to signals table.
SELECT cron.schedule(
  'weather-signal-cron',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL')
               || '/functions/v1/weather-signal',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- auto-settle: every 10 minutes. Polls Kalshi for settled markets and
-- computes P&L on paper trades. Short interval so track record updates fast.
SELECT cron.schedule(
  'auto-settle-cron',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL')
               || '/functions/v1/auto-settle',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body    := '{}'::jsonb
  );
  $$
);
