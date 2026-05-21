-- Fix agent_trades_pending_resolution view: remove auth.uid() filter that broke
-- auto-settle for all users after multi-tenancy migration.
-- Service role bypasses RLS, so no user filter is needed here — each user's
-- data is still isolated at the RLS layer for frontend queries.
CREATE OR REPLACE VIEW public.agent_trades_pending_resolution AS
SELECT
  ticker,
  user_id,
  count(*) AS trades_pending,
  array_agg((id)::text ORDER BY created_at) AS trade_ids,
  min(created_at) AS earliest_entry
FROM trades
WHERE
  mode = 'paper'
  AND status = 'filled'
  AND action = 'buy'
  AND settled_at IS NULL
  AND ticker IS NOT NULL
GROUP BY ticker, user_id;
