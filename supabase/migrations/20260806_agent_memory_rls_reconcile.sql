-- Reconciliation migration: agent_memory RLS + settle_memory_attributions().
--
-- These changes are ALREADY LIVE in production (uyfnezxmgwitpzsrnkst) — applied
-- directly via the Supabase management API on a prior date, never captured as a
-- migration. This file brings the git ledger in line with reality; it does not
-- change production's live behavior. Every statement below was verified against
-- production's actual pg_policies/information_schema/pg_proc before being written,
-- so re-running it against production is a no-op.
--
-- What was fixed, and why it mattered: the last migration to touch this table
-- (20260524_agent_memory_user_id.sql) created ONE "FOR ALL" policy with no
-- `TO authenticated` restriction and no WITH CHECK clause:
--
--   CREATE POLICY "Users can manage own memories" ON public.agent_memory
--     FOR ALL USING (user_id IS NULL OR user_id = auth.uid()::text);
--
-- Because platform-global memories use user_id = NULL, and the policy had no
-- role restriction, this allowed the anon role to INSERT/UPDATE/DELETE
-- platform-global agent_memory rows — rows injected into every user's live
-- trading-agent system prompt. That is an unauthenticated prompt-injection
-- path into a real-money trading system. This migration replaces the single
-- permissive policy with five role-scoped, operation-scoped policies.

-- ── last_evidence_at column (already live) ──────────────────────────────────
ALTER TABLE public.agent_memory
  ADD COLUMN IF NOT EXISTS last_evidence_at TIMESTAMPTZ;

-- ── Drop the old permissive FOR ALL policy and any partial reconciliation ───
DROP POLICY IF EXISTS "Users can manage own memories" ON public.agent_memory;
DROP POLICY IF EXISTS admin_read_agent_memory ON public.agent_memory;
DROP POLICY IF EXISTS agent_memory_delete ON public.agent_memory;
DROP POLICY IF EXISTS agent_memory_insert ON public.agent_memory;
DROP POLICY IF EXISTS agent_memory_select ON public.agent_memory;
DROP POLICY IF EXISTS agent_memory_update ON public.agent_memory;

-- ── Recreate matching production's live policy set exactly ─────────────────
CREATE POLICY agent_memory_select ON public.agent_memory
  FOR SELECT TO authenticated
  USING (user_id IS NULL OR user_id = auth.uid()::text);

CREATE POLICY agent_memory_insert ON public.agent_memory
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY agent_memory_update ON public.agent_memory
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY agent_memory_delete ON public.agent_memory
  FOR DELETE TO authenticated
  USING (user_id = auth.uid()::text);

-- Admins can read every row (including other users' and platform-global) for
-- support/debugging; no write path is granted by this policy.
CREATE POLICY admin_read_agent_memory ON public.agent_memory
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid() AND profiles.is_admin = true
  ));

-- ── settle_memory_attributions() (already live) ─────────────────────────────
-- Stamps settled_at/trade_pnl onto memory_attribution rows once their linked
-- trade settles, so confidence-decay math has real outcomes to work from
-- instead of the attribution sitting unsettled forever.
CREATE OR REPLACE FUNCTION public.settle_memory_attributions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
$function$;
