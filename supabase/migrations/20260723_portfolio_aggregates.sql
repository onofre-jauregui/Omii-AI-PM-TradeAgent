-- Tier 2 performance: server-side portfolio aggregation.
--
-- Before this, the dashboard pulled up to 2,000 raw settled-trade rows to the
-- browser and computed P&L / win-rate / equity in JS on every mode switch. These
-- two SECURITY DEFINER functions aggregate in SQL (scoped to auth.uid()::text) so the
-- client fetches one summary row + ~60 daily buckets instead. A composite index
-- makes both an index scan.
--
-- Date semantics match the prior client math exactly:
--   * settled window starts 2026-04-22 (same MAY_START constant)
--   * equity buckets keyed by the UTC date of settled_at (matches settled_at.slice(0,10))
--   * "today" boundary is passed in by the caller (p_today_start) so it stays the
--     user's LOCAL day, exactly as the old client code computed it.

-- Composite index for the hot settled/open filters + sort.
create index if not exists idx_trades_user_mode_status_settled
  on public.trades (user_id, mode, status, settled_at);

-- One row of scalar portfolio metrics for a user + mode.
create or replace function public.get_portfolio_summary(
  p_mode text default null,
  p_today_start timestamptz default date_trunc('day', now())
)
returns table (
  starting_balance numeric,
  total_pnl numeric,
  today_pnl numeric,
  settled_count bigint,
  winners bigint,
  losers bigint,
  open_positions bigint,
  trades_today bigint,
  last_settled_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with settled as (
    select t.pnl, t.settled_at
    from trades t
    where t.user_id = auth.uid()::text
      and t.status = 'settled'
      and t.settled_at >= '2026-04-22T00:00:00Z'::timestamptz
      and (p_mode is null or t.mode = p_mode)
  )
  select
    coalesce((
      select sum(s.starting_balance) from strategies s
      where s.user_id = auth.uid()::text and (p_mode is null or s.mode = p_mode)
    ), 0)::numeric                                                             as starting_balance,
    coalesce((select sum(pnl) from settled), 0)::numeric                       as total_pnl,
    coalesce((select sum(pnl) from settled where settled_at >= p_today_start), 0)::numeric as today_pnl,
    (select count(*) from settled)                                            as settled_count,
    (select count(*) from settled where pnl > 0)                              as winners,
    (select count(*) from settled where pnl < 0)                              as losers,
    (
      select count(*) from trades t
      where t.user_id = auth.uid()::text and t.status = 'filled' and t.settled_at is null
        and (p_mode is null or t.mode = p_mode)
    )                                                                          as open_positions,
    (
      select count(*) from trades t
      where t.user_id = auth.uid()::text and t.created_at >= p_today_start
        and (p_mode is null or t.mode = p_mode)
    )                                                                          as trades_today,
    (select max(settled_at) from settled)                                     as last_settled_at;
$$;

-- Daily settled-P&L buckets (UTC date) for the equity curve + win-streak, so the
-- client cumulates ~60 rows instead of scanning thousands of trades.
create or replace function public.get_equity_curve(p_mode text default null)
returns table (day date, day_pnl numeric)
language sql
stable
security definer
set search_path = public
as $$
  select (t.settled_at at time zone 'UTC')::date as day, sum(t.pnl)::numeric as day_pnl
  from trades t
  where t.user_id = auth.uid()::text
    and t.status = 'settled'
    and t.settled_at >= '2026-04-22T00:00:00Z'::timestamptz
    and (p_mode is null or t.mode = p_mode)
  group by 1
  order by 1;
$$;

grant execute on function public.get_portfolio_summary(text, timestamptz) to authenticated;
grant execute on function public.get_equity_curve(text) to authenticated;
