-- baskets was never included in 20260403000000_multi_tenancy.sql's user_id
-- rollout — confirmed via information_schema: it has no user_id column at
-- all, and RLS is enabled with zero policies (so even a service-role-bypass
-- aside, any direct user-JWT read would return nothing).
--
-- This means execute-basket has been completely non-functional for every
-- authenticated caller since tenant-scoping was added to it: it always
-- calls tenantInsertFields(tenant.userId), which spreads {user_id: ...} into
-- the insert payload, and PostgREST rejects the whole insert with
-- "Could not find the 'user_id' column of 'baskets' in the schema cache" —
-- a 500 on every single basket-execution attempt. Found via a live
-- integration test during the 2026-07-31 production-readiness follow-up
-- (execute-basket had zero test coverage before this session).
--
-- Same pattern as 20260403000000_multi_tenancy.sql: TEXT column (works
-- before/after Supabase Auth, UUID stored as text), NULL = legacy single-
-- tenant fallback, user_id = auth.uid() for real isolation.

ALTER TABLE public.baskets ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_baskets_user_id ON public.baskets (user_id);

DROP POLICY IF EXISTS "baskets_user_isolation" ON public.baskets;
CREATE POLICY "baskets_user_isolation" ON public.baskets
  FOR ALL USING (user_id IS NULL OR user_id = auth.uid()::text)
  WITH CHECK (user_id IS NULL OR user_id = auth.uid()::text);
