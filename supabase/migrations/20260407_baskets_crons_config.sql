-- NOTE (2026-08-06): each cron.schedule() call below used to be closed by a
-- trailing upsert clause. That clause belongs to INSERT, not SELECT, so it was
-- invalid SQL and this file could never apply cleanly to any database, Supabase
-- included — it was recorded as applied without ever running to completion.
-- pg_cron's schedule() already replaces a job of the same name, so removing the
-- clause preserves the intent exactly. Found by scripts/rehearse-migrations.sh.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. baskets table — multi-leg order state machine
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists baskets (
  id uuid primary key default gen_random_uuid(),

  -- Strategy attribution
  strategy_id text references strategies(id) on delete set null,
  strategy_name text,

  -- Source alert (from surface_alerts)
  alert_id uuid references surface_alerts(id) on delete set null,

  -- State machine
  -- pending → executing → completed | aborted | timed_out | partially_filled | flattened
  status text not null default 'pending'
    check (status in ('pending', 'executing', 'completed', 'aborted', 'timed_out', 'partially_filled', 'flattened')),

  -- Progress
  leg_count integer not null default 2,
  legs_filled integer not null default 0,

  -- Edge and execution context
  expected_edge_cents integer,
  mode text not null default 'paper' check (mode in ('paper', 'live')),
  reasoning text,
  abort_reason text,

  -- Timing
  started_at timestamptz default now(),
  timeout_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

create index if not exists baskets_status_idx on baskets (status);
create index if not exists baskets_strategy_idx on baskets (strategy_id);
create index if not exists baskets_created_at_idx on baskets (created_at desc);

alter table baskets enable row level security;
DROP POLICY IF EXISTS "Service role full access on baskets" ON baskets;
create policy "Service role full access on baskets"
  on baskets for all using (true) with check (true);

-- Add basket_id to trades table so legs are linked to their basket
alter table trades add column if not exists basket_id uuid references baskets(id) on delete set null;
alter table trades add column if not exists exit_reason text; -- 'take_profit' | 'stop_loss' | 'timeout' | 'basket_flatten' | 'manual' | 'expired'
alter table trades add column if not exists slippage_cents integer; -- filled_price - requested_price

create index if not exists trades_basket_id_idx on trades (basket_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. strategy_config table — externalized per-strategy parameters
--    Separates tunable numbers from the natural-language instructions.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists strategy_config (
  strategy_id text primary key references strategies(id) on delete cascade,

  -- Signal thresholds
  min_edge_cents integer not null default 3,          -- minimum edge to trade
  min_liquidity_score numeric(4,2) not null default 0.3,
  min_composite_score numeric(4,2) not null default 0.4,

  -- Position sizing
  max_position_usd numeric(10,2) not null default 50,
  min_position_usd numeric(10,2) not null default 10,

  -- Basket execution
  max_legs integer not null default 2,
  basket_timeout_seconds integer not null default 30,
  min_post_fill_edge_cents integer not null default 2, -- abort if edge drops below this after first fill

  -- Time constraints
  min_days_to_close numeric(10,2) not null default 0.1,  -- don't trade if closing in < 2.4 hours
  max_days_to_close numeric(10,2) not null default 90,

  -- Kill switch
  max_consecutive_failures integer not null default 5,  -- halt strategy after N failures
  consecutive_failures integer not null default 0,       -- current failure count (reset on success)
  is_halted boolean not null default false,
  halt_reason text,

  updated_at timestamptz default now()
);

alter table strategy_config enable row level security;
DROP POLICY IF EXISTS "Service role full access on strategy_config" ON strategy_config;
create policy "Service role full access on strategy_config"
  on strategy_config for all using (true) with check (true);

-- Seed default configs for all four strategies
insert into strategy_config (strategy_id, min_edge_cents, min_liquidity_score, max_position_usd, max_legs, basket_timeout_seconds, min_post_fill_edge_cents)
values
  ('S-001', 3,  0.4, 50, 2, 30, 2),   -- Surface Arb: tight edge, fast timeout
  ('S-002', 5,  0.3, 40, 1, 0,  0),   -- Resolution Fade: single-leg, no basket
  ('S-003', 15, 0.3, 75, 1, 0,  0),   -- Economic Consensus: single-leg, wider edge
  ('S-004', 6,  0.5, 20, 1, 0,  0)    -- Liquidity Provision: single-leg, tight spread
on conflict (strategy_id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Update cron schedules
--    Kalshi Basic tier: 20 req/sec public endpoints
--    Per scan: 11 series × 1 req = 11 req → safe at any interval ≥ 1 sec
--    pg_cron 1.5+ supports second-level syntax: '15 seconds'
--    Falling back to 1-minute if Supabase pg_cron < 1.5
-- ─────────────────────────────────────────────────────────────────────────────

-- Surface scanner: every 15 seconds
-- (change to '* * * * *' if your Supabase instance doesn't support second syntax)
select cron.schedule(
  'surface-scanner-cron',
  '15 seconds',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_URL') || '/functions/v1/surface-scanner',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Signal generator: every 15 seconds
select cron.schedule(
  'signal-generator-cron',
  '15 seconds',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_URL') || '/functions/v1/signal-generator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body := '{"limit": 50}'::jsonb
  );
  $$
);

-- Auto-trade: every 5 minutes
-- (the agent loop itself takes 30–90 seconds to run per strategy)
select cron.schedule(
  'auto-trade-cron',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_URL') || '/functions/v1/auto-trade',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Apply migration to live DB
-- ─────────────────────────────────────────────────────────────────────────────
-- Run this file via: supabase db push  OR  paste into Supabase SQL editor
