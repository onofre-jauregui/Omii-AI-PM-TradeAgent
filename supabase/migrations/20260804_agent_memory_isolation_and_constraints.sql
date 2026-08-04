-- agent_memory: close the write-side RLS escape, widen the type CHECKs that were
-- silently rejecting three writers, and add the column the confidence decay needs.
--
-- Context: edge functions use the service-role key and bypass RLS entirely, so
-- these policies govern the browser only. That made the gaps below easy to miss —
-- nothing in the backend behaved differently because of them.

-- ── 1. Type CHECKs ────────────────────────────────────────────────────────────
-- Three writers have been inserting values the CHECK constraints reject, and none
-- of them inspected the returned error, so each has failed 100% of the time with
-- no trace:
--   * trading-agent's `remember` tool          → memory_type 'user_preference'
--   * backtest-weather's calibration writeback → memory_type 'market_condition'
--                                                and source_type 'backtest'
-- The per-user preference feature and GFS bias calibration have therefore never
-- reached agent memory at all. These are legitimate categories, so widen the
-- domain rather than rewriting the callers to lie about what a row is.
--
-- trading-agent also *reads* memory_type = 'user_preference' to build the user
-- identity block, which is why that block has always been empty.

ALTER TABLE public.agent_memory DROP CONSTRAINT IF EXISTS agent_memory_memory_type_check;
ALTER TABLE public.agent_memory ADD CONSTRAINT agent_memory_memory_type_check
  CHECK (memory_type = ANY (ARRAY[
    'lesson', 'pattern', 'mistake', 'success', 'market_note', 'strategy_insight',
    'user_preference',  -- trading-agent `remember` tool
    'market_condition'  -- backtest-weather forecast-bias calibration
  ]));

ALTER TABLE public.agent_memory DROP CONSTRAINT IF EXISTS agent_memory_source_type_check;
ALTER TABLE public.agent_memory ADD CONSTRAINT agent_memory_source_type_check
  CHECK (source_type = ANY (ARRAY[
    'reflection', 'trade_outcome', 'user_feedback', 'market_observation', 'manual',
    'backtest'  -- backtest-weather
  ]));

-- ── 2. last_evidence_at ───────────────────────────────────────────────────────
-- The Bayesian decay in auto-reflect computes age from `last_updated_at`, which
-- that same UPDATE rewrites to now() on every pass. Age is therefore always ~0,
-- the decay factor is always ~1, and no memory has ever decayed. Decay needs a
-- timestamp that tracks when *evidence* last arrived, not when the row was last
-- touched.
ALTER TABLE public.agent_memory ADD COLUMN IF NOT EXISTS last_evidence_at timestamptz;

COMMENT ON COLUMN public.agent_memory.last_evidence_at IS
  'When a settled trade attribution last moved alpha/beta. Drives confidence decay; unlike last_updated_at it is not bumped by unrelated writes.';

-- Backfill from the attribution ledger so existing memories start with a real age
-- rather than looking brand new. Memories with no settled attribution stay NULL,
-- which the decay treats as "no evidence yet" (exposed_confidence already
-- requires a minimum sample before it is published at all).
UPDATE public.agent_memory m
SET last_evidence_at = a.max_settled
FROM (
  SELECT memory_id, max(settled_at) AS max_settled
  FROM public.memory_attribution
  WHERE settled_at IS NOT NULL
  GROUP BY memory_id
) a
WHERE m.id = a.memory_id
  AND m.last_evidence_at IS NULL;

-- ── 3. Indexes ────────────────────────────────────────────────────────────────
-- idx_agent_memory_user (20260404) and idx_agent_memory_user_id (20260524) are
-- the same index on the same column; the second is partial but every row the hot
-- path wants has a non-null user_id. Keep the partial one.
DROP INDEX IF EXISTS public.idx_agent_memory_user;

-- The hot read path is now (user_id, is_active) filtered on merged_into /
-- quarantined_at, ordered by confidence — no existing index covers it.
CREATE INDEX IF NOT EXISTS idx_agent_memory_recall
  ON public.agent_memory (user_id, is_active, confidence DESC)
  WHERE merged_into IS NULL AND quarantined_at IS NULL;

-- ── 4. RLS ────────────────────────────────────────────────────────────────────
-- Six permissive policies had accumulated, and permissive policies OR together,
-- so the effective grant was the union of all of them. Two problems:
--
--   a) None declared a role, so every policy applied to PUBLIC — including `anon`.
--      For an anonymous session auth.uid() is NULL, so `user_id = auth.uid()::text`
--      is NULL, but `user_id IS NULL` is TRUE. An unauthenticated visitor could
--      therefore INSERT platform-global memories and UPDATE or DELETE existing
--      ones. Platform rows are injected into every opted-in user's prompt, so that
--      is an unauthenticated prompt-injection path into the trading agent.
--
--   b) The same `user_id IS NULL` clause on the write policies let any signed-in
--      user create or edit platform-global rows on behalf of everyone.
--
-- Replaced with four policies, all TO authenticated: SELECT still sees own rows
-- plus platform rows (shared lessons are the point of the platform tier), while
-- INSERT/UPDATE/DELETE are strictly own-rows-only. Writing platform memory is a
-- service-role operation — it belongs to the promotion pipeline, not to clients.
DROP POLICY IF EXISTS "agent_memory_select" ON public.agent_memory;
DROP POLICY IF EXISTS "agent_memory_insert" ON public.agent_memory;
DROP POLICY IF EXISTS "agent_memory_update" ON public.agent_memory;
DROP POLICY IF EXISTS "agent_memory_delete" ON public.agent_memory;
DROP POLICY IF EXISTS "Users can manage own memories" ON public.agent_memory;
DROP POLICY IF EXISTS "admin_read_agent_memory" ON public.agent_memory;

CREATE POLICY "agent_memory_select" ON public.agent_memory
  FOR SELECT TO authenticated
  USING (user_id IS NULL OR user_id = auth.uid()::text);

CREATE POLICY "agent_memory_insert" ON public.agent_memory
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "agent_memory_update" ON public.agent_memory
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "agent_memory_delete" ON public.agent_memory
  FOR DELETE TO authenticated
  USING (user_id = auth.uid()::text);

-- Admin read stays, scoped to authenticated so it cannot be reached anonymously.
CREATE POLICY "admin_read_agent_memory" ON public.agent_memory
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid() AND profiles.is_admin = TRUE
  ));

-- anon has no policy on this table at all now. Make the grant match the intent so
-- the denial is a permission error rather than a silently empty result set.
REVOKE ALL ON public.agent_memory FROM anon;
