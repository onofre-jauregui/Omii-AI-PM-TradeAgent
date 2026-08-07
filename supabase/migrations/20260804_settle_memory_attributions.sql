-- Repair the memory attribution settlement path, which has never run.
--
-- auto-reflect backfills memory_attribution.settled_at/trade_pnl from the trade
-- each memory was cited on. It did that by selecting `id, trade_id` and updating
-- `.eq("id", attr.id)` — but memory_attribution has no `id` column; its primary
-- key is (trade_id, memory_id). supabase-js returns that error rather than
-- throwing, and the caller only destructured `data`, so the result was null, the
-- `if (rows.length)` guard skipped the loop, and the surrounding try/catch never
-- fired. No error, no alert, no work done, on every hourly run since the feature
-- shipped.
--
-- The consequence is the whole Bayesian confidence layer: alpha/beta only move
-- when an attribution settles, so with zero settlements no memory has ever
-- accumulated a sample, earned an exposed_confidence, or been quarantined. At the
-- time of this migration: 99 attributions, 0 settled.
--
-- Replacing the loop with one set-based statement fixes the column names and
-- removes two scaling problems at the same time: the per-row SELECT+UPDATE (two
-- round trips per attribution) and the LIMIT 100 that capped throughput at 100
-- settlements/hour regardless of trade volume.

CREATE OR REPLACE FUNCTION public.settle_memory_attributions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  settled_count integer;
BEGIN
  WITH updated AS (
    UPDATE public.memory_attribution ma
    SET settled_at = t.settled_at,
        trade_pnl  = t.pnl
    FROM public.trades t
    WHERE t.id = ma.trade_id
      AND ma.settled_at IS NULL
      AND t.settled_at IS NOT NULL
    RETURNING ma.memory_id
  )
  SELECT count(*) INTO settled_count FROM updated;

  RETURN settled_count;
END;
$$;

COMMENT ON FUNCTION public.settle_memory_attributions() IS
  'Links settled trade PnL onto memory_attribution rows. Returns the number settled. Called hourly by auto-reflect, replacing a per-row loop that queried a non-existent id column and silently did nothing.';

REVOKE ALL ON FUNCTION public.settle_memory_attributions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_memory_attributions() TO service_role;
