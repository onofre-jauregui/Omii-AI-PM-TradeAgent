-- Risk baseline reset: lets a human explicitly say "the condition that caused
-- this suspension has been fixed, evaluate my health from this point forward"
-- instead of the strategy-health monitor forever weighing trades from before
-- the fix.
--
-- auto-reflect's Sharpe/drawdown/hit-rate/consecutive-loss evaluation pulls a
-- fixed window of the last 30 settled trades (see auto-reflect/index.ts). For
-- a low-volume strategy that window can BE its entire history, so two bad
-- trades from before a root-cause fix can never age out on their own — the
-- strategy stays suspended, which blocks the new trades that would eventually
-- push them out of the window. Auto-resume (24h timeout) clears
-- suspended_until but does not touch this column — only a deliberate human
-- override does, via the Strategies panel toggle. That distinction matters:
-- if routine auto-resume also reset the baseline, a persistently bad strategy
-- could escape evaluation forever on the ordinary 24h cycle.
--
-- NULL = no reset has occurred; evaluate the full last-30-trade history
-- (today's behavior, unchanged, for every existing strategy).
ALTER TABLE strategies
  ADD COLUMN IF NOT EXISTS risk_baseline_reset_at TIMESTAMPTZ;
