-- Fix agent_trades_pending_resolution to group by (ticker, user_id).
-- Previously grouped by ticker only, causing all users' trades on the same
-- market to be settled in a single batch — risking cross-user P&L corruption.
-- Now each (ticker, user_id) pair is an independent row so auto-settle
-- processes each user's positions independently.

CREATE OR REPLACE VIEW public.agent_trades_pending_resolution AS
SELECT
  ticker,
  user_id,
  COUNT(*)                                   AS trades_pending,
  ARRAY_AGG(id::text ORDER BY created_at)    AS trade_ids,
  MIN(created_at)                            AS earliest_entry
FROM public.trades
WHERE
  mode       = 'paper'
  AND status = 'filled'
  AND action = 'buy'
  AND settled_at IS NULL
  AND ticker IS NOT NULL
GROUP BY ticker, user_id;
