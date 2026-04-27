-- spread_history: intraday order book snapshots for spread-arb analysis (S-004).
-- Populated by a future market-snapshot cron; queried by backtest spread_compression mode.
create table if not exists spread_history (
  id          uuid primary key default gen_random_uuid(),
  ticker      text not null,
  strategy_id text,            -- which strategy is watching this market
  yes_bid     integer,         -- cents (1-99)
  yes_ask     integer,
  spread      integer generated always as (yes_ask - yes_bid) stored,
  volume      integer,
  open_interest integer,
  snapshot_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists spread_history_ticker_at on spread_history (ticker, snapshot_at desc);
create index if not exists spread_history_strategy_at on spread_history (strategy_id, snapshot_at desc);

-- outcome_correct and outcome_pnl columns on signals (backfill-safe add-if-missing).
-- These are already present from earlier migration; guard with IF NOT EXISTS.
alter table signals add column if not exists outcome_correct boolean;
alter table signals add column if not exists outcome_pnl     numeric(10,2);

-- Index to make param_sweep and signal_quality queries fast.
create index if not exists signals_outcome_source on signals (source, outcome_correct)
  where outcome_correct is not null;

-- backtest_apply: stores the latest recommended config update derived from backtest results.
-- A future backtest-apply function reads from backtest_runs and writes recommendations here,
-- then auto-trade reads from here to tune its thresholds at runtime.
create table if not exists backtest_recommendations (
  id              uuid primary key default gen_random_uuid(),
  strategy_id     text not null,
  backtest_run_id uuid references backtest_runs(id),
  param_name      text not null,       -- e.g. 'min_edge_cents'
  recommended_value numeric not null,
  current_value   numeric,
  win_rate_at_rec numeric,
  trade_count     integer,
  applied         boolean default false,
  applied_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists backtest_rec_strategy on backtest_recommendations (strategy_id, applied, created_at desc);
