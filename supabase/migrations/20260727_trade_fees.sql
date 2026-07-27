-- Adopts the schema from docs/design/full-transaction-cost.md (Option A,
-- two-layer cost attribution): per-trade net P&L subtracts only directly
-- attributable cost (Kalshi fee + this trade's own AI qualify call); shared
-- AI runs stay a separate platform-overhead line, not forced onto trades.
--
-- Scoping note: ai_qualify_cost_usd ships nullable/unpopulated in this
-- migration's companion code change — it requires a per-model $/token
-- pricing table that doesn't exist yet. entry_fee_cents/exit_fee_cents/
-- net_pnl (Kalshi-fee-only) are populated by this change; gross pnl is
-- kept untouched alongside net_pnl, per the design doc.
--
-- Apply via the Supabase management API (POST /database/query), never
-- `supabase db push` — this project's migration history is out of sync
-- with the remote.

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS entry_fee_cents integer,
  ADD COLUMN IF NOT EXISTS exit_fee_cents integer,
  ADD COLUMN IF NOT EXISTS ai_qualify_cost_usd numeric,
  ADD COLUMN IF NOT EXISTS net_pnl numeric;

COMMENT ON COLUMN public.trades.entry_fee_cents IS
  'Kalshi trading fee on the entry fill, in cents. Live: captured verbatim from Kalshi''s own maker_fees_dollars/taker_fees_dollars order-response field. Paper: estimated via the published fee formula (see _shared/fill-sim.ts estimateKalshiFee).';
COMMENT ON COLUMN public.trades.exit_fee_cents IS
  'Kalshi trading fee on an exit fill (position closed before settlement), in cents. Null/0 when held to settlement (no exit trade fired).';
COMMENT ON COLUMN public.trades.ai_qualify_cost_usd IS
  'Cost of this trade''s own LLM qualify call (S-002/S-005 only; S-001 is rule-based, always 0). Not yet populated — requires a per-model pricing table (follow-up).';
COMMENT ON COLUMN public.trades.net_pnl IS
  'pnl minus (entry_fee_cents + exit_fee_cents)/100 minus ai_qualify_cost_usd, computed at settlement. Gross pnl column is kept unchanged alongside this.';
