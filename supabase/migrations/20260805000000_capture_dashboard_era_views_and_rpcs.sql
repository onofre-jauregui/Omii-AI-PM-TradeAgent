-- Capture the four views and two RPCs that existed only in the production
-- database, completing the schema-in-git gap that 20260316000000 opened on.
--
-- Production has 6 public views; the migration set created 2. It has 13 public
-- functions; three of these were never written down. Read verbatim from the
-- production catalogue of uyfnezxmgwitpzsrnkst on 2026-08-06.
--
-- Sorted last because every one of them selects from tables created across the
-- whole migration range — `signals` (20260406), `trade_reflections` (20260404),
-- `strategy_config` (20260407), `strategies` (20260402100000). A view body is
-- resolved at CREATE time, so these cannot sit earlier in the sequence.
--
-- `CREATE OR REPLACE VIEW` cannot change an existing view's column list, so each
-- is dropped first. Dropping and recreating a view is metadata-only — no data
-- moves — which is what makes this safe to apply to production as a no-op.

-- ── agent_activity_daily ───────────────────────────────────────────────────
DROP VIEW IF EXISTS public.agent_activity_daily;
CREATE VIEW public.agent_activity_daily AS
  SELECT (date_trunc('day'::text, (created_at AT TIME ZONE 'UTC'::text)))::date AS day,
    count(*) AS trades_total,
    count(*) FILTER (WHERE (status = 'filled'::text)) AS trades_filled,
    count(*) FILTER (WHERE (status = 'failed'::text)) AS trades_failed,
    count(*) FILTER (WHERE (status = 'cancelled'::text)) AS trades_cancelled,
    count(DISTINCT strategy_id) AS strategies_used,
    sum(amount) FILTER (WHERE (status = 'filled'::text)) AS capital_deployed,
    sum(pnl) FILTER (WHERE (status = 'filled'::text)) AS realized_pnl,
    round(avg(filled_price) FILTER (WHERE (status = 'filled'::text)), 2) AS avg_fill_price,
    count(DISTINCT ticker) FILTER (WHERE (status = 'filled'::text)) AS unique_markets
   FROM trades
  WHERE ((mode = 'paper'::text) AND ((user_id = (auth.uid())::text) OR (user_id IS NULL)))
  GROUP BY ((date_trunc('day'::text, (created_at AT TIME ZONE 'UTC'::text)))::date)
  ORDER BY ((date_trunc('day'::text, (created_at AT TIME ZONE 'UTC'::text)))::date) DESC;

-- ── agent_recent_trades ────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.agent_recent_trades;
CREATE VIEW public.agent_recent_trades AS
  SELECT t.created_at,
    t.strategy_id,
    t.ticker,
    t.market_question,
    t.side,
    t.action,
    (t.price || 'c'::text) AS entry,
    t.amount AS size_usd,
    t.status,
    t.mode,
    SUBSTRING(t.notes FROM 1 FOR 120) AS llm_rationale,
    tr.expected_confidence,
    SUBSTRING(tr.expected_outcome FROM 1 FOR 100) AS expected_outcome
   FROM (trades t
     LEFT JOIN trade_reflections tr ON ((tr.trade_id = t.id)))
  WHERE ((t.user_id = (auth.uid())::text) OR (t.user_id IS NULL))
  ORDER BY t.created_at DESC
 LIMIT 50;

-- ── agent_signal_health ────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.agent_signal_health;
CREATE VIEW public.agent_signal_health AS
  SELECT date_trunc('hour'::text, created_at) AS hour,
    count(*) AS signals_generated,
    count(*) FILTER (WHERE (direction <> 'skip'::text)) AS actionable,
    count(*) FILTER (WHERE (signal_strength = 'strong'::text)) AS strong,
    count(*) FILTER (WHERE (time_value_score >= 0.65)) AS short_horizon,
    count(*) FILTER (WHERE ((time_value_score >= 0.65) AND (edge_cents >= (5)::numeric) AND (direction <> 'skip'::text))) AS s002_eligible,
    round(avg(composite_score), 2) AS avg_composite
   FROM signals
  WHERE (created_at > (now() - '24:00:00'::interval))
  GROUP BY (date_trunc('hour'::text, created_at))
  ORDER BY (date_trunc('hour'::text, created_at)) DESC;

-- ── agent_strategy_performance ─────────────────────────────────────────────
DROP VIEW IF EXISTS public.agent_strategy_performance;
CREATE VIEW public.agent_strategy_performance AS
  SELECT COALESCE(t.strategy_id, 'unknown'::text) AS strategy_id,
    s.name AS strategy_name,
    s.active AS strategy_active,
    sc.is_halted,
    sc.halt_reason,
    count(t.*) AS trades_total,
    count(t.*) FILTER (WHERE (t.status = 'filled'::text)) AS trades_filled,
    count(t.*) FILTER (WHERE (t.status = 'failed'::text)) AS trades_failed,
    sum(t.amount) FILTER (WHERE (t.status = 'filled'::text)) AS capital_deployed,
    sum(t.pnl) FILTER (WHERE (t.status = 'filled'::text)) AS realized_pnl,
    min(t.created_at) AS first_trade,
    max(t.created_at) AS last_trade
   FROM ((trades t
     LEFT JOIN strategies s ON ((s.id = t.strategy_id)))
     LEFT JOIN strategy_config sc ON ((sc.strategy_id = t.strategy_id)))
  WHERE ((t.mode = 'paper'::text) AND ((t.user_id = (auth.uid())::text) OR (t.user_id IS NULL)))
  GROUP BY t.strategy_id, s.name, s.active, sc.is_halted, sc.halt_reason
  ORDER BY (count(t.*)) DESC;

-- ── Dashboard RPCs ─────────────────────────────────────────────────────────
-- Both are SECURITY DEFINER and scope to auth.uid() internally, so they are the
-- tenant boundary for every number the dashboard renders. The 2026-04-22 floor
-- in each excludes pre-launch test trades from the reported track record.

CREATE OR REPLACE FUNCTION public.get_equity_curve(p_mode text DEFAULT NULL::text)
RETURNS TABLE(day date, day_pnl numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select (t.settled_at at time zone 'UTC')::date as day, sum(t.pnl)::numeric as day_pnl
  from trades t
  where t.user_id = auth.uid()::text
    and t.status = 'settled'
    and t.settled_at >= '2026-04-22T00:00:00Z'::timestamptz
    and (p_mode is null or t.mode = p_mode)
  group by 1
  order by 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_portfolio_summary(
  p_mode text DEFAULT NULL::text,
  p_today_start timestamp with time zone DEFAULT date_trunc('day'::text, now())
)
RETURNS TABLE(
  starting_balance numeric, total_pnl numeric, today_pnl numeric,
  settled_count bigint, winners bigint, losers bigint,
  open_positions bigint, trades_today bigint, last_settled_at timestamp with time zone
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
$function$;
