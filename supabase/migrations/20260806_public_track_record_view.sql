-- Public track record view.
--
-- /performance is an unauthenticated route — the shareable track record, and the
-- artifact the whole paper-trading-first strategy exists to produce. It queried
-- `trades` directly with the anon key. RLS on that table is
-- `trades_user_isolation` (USING user_id = auth.uid()), and auth.uid() is NULL
-- for an anonymous request, so PostgREST filtered every row out and returned
-- `[]` — not an error, an empty array. The page rendered "+$0.00 · 0 trades ·
-- Days Running 0" to every visitor while the account behind it had 814 settled
-- paper trades and +$713.37 realised since 2026-04-17.
--
-- Fixing this with an anon SELECT policy on `trades` was rejected: the table has
-- 40 columns including order_id, trace_id, notes, user_id and
-- ai_qualify_cost_usd, and a policy grants all of them plus any column added
-- later. This view is an explicit allowlist instead — adding a sensitive column
-- to `trades` cannot leak it here without someone editing this file.
--
-- The view intentionally runs with the definer's rights (the PG default,
-- security_invoker = false) so it reads past the base table's RLS. That is the
-- mechanism, not an oversight: it exposes exactly one curated slice — one
-- account, paper mode, display columns only — and callers cannot widen it,
-- because the predicates live here rather than in a client-supplied filter.
--
-- PAPER MODE ONLY, deliberately. Live-mode results are real-money performance and
-- are not public. Because `mode` is fixed in the view rather than filtered by the
-- caller, a client that requests `?mode=eq.live` gets an empty set instead of
-- real-money P&L — the exposure cannot be reintroduced from the frontend.

create or replace view public.public_track_record as
select
  t.id,
  t.ticker,
  t.market_question,
  t.side,
  t.action,
  t.price,
  t.amount,
  t.pnl,
  t.net_pnl,
  t.status,
  t.mode,
  t.strategy,
  t.strategy_id,
  t.resolution,
  t.exit_reason,
  t.created_at,
  t.filled_at,
  t.settled_at
from public.trades t
where t.user_id = 'ea207ba1-b7a9-4a7b-96bc-922e922d627d'
  and t.mode = 'paper'
  and t.status in ('filled', 'settled');

comment on view public.public_track_record is
  'Read-only public slice of the track-record account''s filled and settled PAPER '
  'trades. Backs the unauthenticated /performance page. Live-mode results are '
  'real-money performance and must never be exposed here. Display columns only — '
  'never add a column without confirming it is safe to publish to anonymous visitors.';

-- Anonymous visitors are the entire audience for this page; authenticated users
-- hit the same route without a special case.
grant select on public.public_track_record to anon, authenticated;

-- The view is read-only by construction, but be explicit: nothing about a public
-- track record should ever accept a write.
revoke insert, update, delete on public.public_track_record from anon, authenticated;
