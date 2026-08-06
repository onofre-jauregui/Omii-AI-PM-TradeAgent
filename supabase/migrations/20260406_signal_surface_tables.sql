-- NOTE (2026-08-06): each cron.schedule() call below used to be closed by a
-- trailing upsert clause. That clause belongs to INSERT, not SELECT, so it was
-- invalid SQL and this file could never apply cleanly to any database, Supabase
-- included — it was recorded as applied without ever running to completion.
-- pg_cron's schedule() already replaces a job of the same name, so removing the
-- clause preserves the intent exactly. Found by scripts/rehearse-migrations.sh.

-- ─────────────────────────────────────────────────────────────────────────────
-- Signal Generator + Surface Scanner tables
-- ─────────────────────────────────────────────────────────────────────────────

-- signals: persisted output from the signal-generator function.
-- Each row represents a scored signal for a specific market at a point in time.
create table if not exists signals (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  market_question text,
  event_ticker text,

  -- Signal output
  direction text not null check (direction in ('buy_yes', 'buy_no', 'skip')),
  signal_strength text not null check (signal_strength in ('strong', 'moderate', 'weak')),
  reasoning text,

  -- Market state at signal time (prices in cents)
  mid_price integer,
  spread integer,
  volume integer,
  days_to_close numeric(10,2),
  expires_at timestamptz,

  -- Dimension scores (0.0 – 1.0)
  composite_score numeric(4,2),
  liquidity_score numeric(4,2),
  edge_score numeric(4,2),
  time_value_score numeric(4,2),
  volume_rank_score numeric(4,2),

  -- Outcome tracking (filled in by auto-reflect or manually)
  was_acted_on boolean default false,
  outcome_pnl numeric(10,2),
  outcome_correct boolean,

  created_at timestamptz default now()
);

create index if not exists signals_ticker_idx on signals (ticker);
create index if not exists signals_direction_idx on signals (direction);
create index if not exists signals_composite_score_idx on signals (composite_score desc);
create index if not exists signals_created_at_idx on signals (created_at desc);

-- surface_alerts: persisted output from the surface-scanner function.
-- Each row represents a detected cross-market inconsistency.
create table if not exists surface_alerts (
  id uuid primary key default gen_random_uuid(),
  detected_at timestamptz default now(),

  alert_type text not null check (
    alert_type in ('monotonicity_violation', 'bracket_sum_violation', 'spread_anomaly')
  ),

  event_ticker text not null,
  ticker_a text not null,
  ticker_b text,          -- null for single-market alerts (bracket sum, spread)

  -- Prices in cents at detection time
  price_a_cents integer,
  price_b_cents integer,

  -- Edge and confidence
  expected_edge_cents integer not null,
  confidence numeric(4,2),

  -- Human-readable context
  description text,
  action text,            -- what the agent should do to exploit this

  -- Tracking
  is_exploited boolean default false,
  exploited_at timestamptz,
  exploited_by_trade_id uuid references trades(id),

  created_at timestamptz default now()
);

create index if not exists surface_alerts_event_idx on surface_alerts (event_ticker);
create index if not exists surface_alerts_type_idx on surface_alerts (alert_type);
create index if not exists surface_alerts_exploited_idx on surface_alerts (is_exploited);
create index if not exists surface_alerts_edge_idx on surface_alerts (expected_edge_cents desc);
create index if not exists surface_alerts_created_at_idx on surface_alerts (created_at desc);

-- Enable RLS (service role bypasses these anyway)
alter table signals enable row level security;
alter table surface_alerts enable row level security;

DROP POLICY IF EXISTS "Service role full access on signals" ON signals;
create policy "Service role full access on signals"
  on signals for all
  using (true)
  with check (true);

DROP POLICY IF EXISTS "Service role full access on surface_alerts" ON surface_alerts;
create policy "Service role full access on surface_alerts"
  on surface_alerts for all
  using (true)
  with check (true);

-- Register surface-scanner cron: run every 30 minutes during market hours
-- (requires pg_cron extension already enabled by prior migrations)
select cron.schedule(
  'surface-scanner-cron',
  '*/30 * * * *',
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

-- Register signal-generator cron: run every 15 minutes
select cron.schedule(
  'signal-generator-cron',
  '*/15 * * * *',
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
