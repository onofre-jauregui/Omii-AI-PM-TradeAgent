-- Functional verification of agent_memory tenant isolation.
--
-- Runs entirely inside a transaction that is rolled back, so it writes nothing.
-- Every check RAISEs on failure, so a green run is a green run — there is no
-- output to eyeball and misread.
--
-- Why SQL rather than an integration test through PostgREST: RLS is evaluated
-- against the request role and its JWT claims, and `SET LOCAL ROLE` +
-- `request.jwt.claims` reproduces that exactly without needing a real session
-- for each tenant. The service-role key used by every edge function bypasses RLS
-- entirely, so RLS is the browser's control surface and this is where it is
-- proven.
--
-- Run:
--   curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
--     -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN_KTA" \
--     -H "Content-Type: application/json" \
--     --data-binary @<(python3 -c "import json;print(json.dumps({'query':open('supabase/tests/agent_memory_isolation.sql').read()}))")

DO $$
DECLARE
  tenant_a   text;   -- a non-admin owner with memories
  tenant_b   text;   -- any other owner
  visible    bigint;
  own_rows   bigint;
  foreign_rows bigint;
  policy_count int;
  bad_roles  int;
  anon_grants int;
  denied     boolean;
BEGIN
  -- Pick a NON-ADMIN owner. Admins legitimately read every row via
  -- admin_read_agent_memory, so testing isolation as an admin proves nothing —
  -- an earlier run of this check "failed" for exactly that reason.
  SELECT m.user_id INTO tenant_a
  FROM public.agent_memory m
  JOIN public.profiles p ON p.id::text = m.user_id
  WHERE COALESCE(p.is_admin, false) = false
  GROUP BY m.user_id
  ORDER BY count(*) DESC
  LIMIT 1;

  SELECT m.user_id INTO tenant_b
  FROM public.agent_memory m
  WHERE m.user_id IS DISTINCT FROM tenant_a
  GROUP BY m.user_id
  ORDER BY count(*) DESC
  LIMIT 1;

  IF tenant_a IS NULL OR tenant_b IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION: need one non-admin owner and one other owner with memories (got a=%, b=%)', tenant_a, tenant_b;
  END IF;

  -- ── 1. SELECT is scoped ────────────────────────────────────────────────────
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', tenant_a, 'role', 'authenticated')::text, true);

  SELECT count(*), count(*) FILTER (WHERE user_id IS DISTINCT FROM tenant_a)
    INTO own_rows, foreign_rows
  FROM public.agent_memory;

  IF foreign_rows <> 0 THEN
    RAISE EXCEPTION 'ISOLATION: tenant % can read % memories belonging to other tenants', tenant_a, foreign_rows;
  END IF;
  IF own_rows = 0 THEN
    RAISE EXCEPTION 'PRECONDITION: tenant % reads 0 of its own memories — the check would pass vacuously', tenant_a;
  END IF;

  -- ── 2. INSERT cannot forge an owner ────────────────────────────────────────
  denied := false;
  BEGIN
    INSERT INTO public.agent_memory (memory_type, title, content, source_type, user_id)
    VALUES ('lesson', 'isolation probe', 'should be rejected', 'manual', tenant_b);
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    denied := true;
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'ISOLATION: tenant % inserted a memory owned by %', tenant_a, tenant_b;
  END IF;

  -- ── 3. INSERT cannot create a platform-global row ──────────────────────────
  -- user_id NULL is readable by every tenant and is injected into their prompts,
  -- so a client being able to write one is an unauthenticated-adjacent prompt
  -- injection path. Writing platform memory is a service-role operation.
  denied := false;
  BEGIN
    INSERT INTO public.agent_memory (memory_type, title, content, source_type, user_id)
    VALUES ('lesson', 'isolation probe', 'should be rejected', 'manual', NULL);
  EXCEPTION WHEN insufficient_privilege OR check_violation OR not_null_violation THEN
    denied := true;
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'ISOLATION: tenant % created a platform-global (user_id NULL) memory', tenant_a;
  END IF;

  -- ── 4. UPDATE cannot reach another tenant's row ────────────────────────────
  -- No exception expected: RLS filters the row out, so the UPDATE matches zero
  -- rows rather than erroring. Assert on the row count, not on a raised error.
  UPDATE public.agent_memory SET confidence = 0.01 WHERE user_id = tenant_b;
  GET DIAGNOSTICS visible = ROW_COUNT;
  IF visible <> 0 THEN
    RAISE EXCEPTION 'ISOLATION: tenant % updated % rows owned by %', tenant_a, visible, tenant_b;
  END IF;

  -- ── 5. DELETE cannot reach another tenant's row ────────────────────────────
  DELETE FROM public.agent_memory WHERE user_id = tenant_b;
  GET DIAGNOSTICS visible = ROW_COUNT;
  IF visible <> 0 THEN
    RAISE EXCEPTION 'ISOLATION: tenant % deleted % rows owned by %', tenant_a, visible, tenant_b;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claims', NULL, true);

  -- ── 6. anon holds no grants ────────────────────────────────────────────────
  SELECT count(*) INTO anon_grants
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'agent_memory' AND grantee = 'anon';
  IF anon_grants <> 0 THEN
    RAISE EXCEPTION 'ISOLATION: anon still holds % grant(s) on agent_memory', anon_grants;
  END IF;

  -- ── 7. Every policy targets authenticated, none targets PUBLIC ─────────────
  -- A policy with no TO clause applies to PUBLIC (polroles = {0}), which includes
  -- anon. That was the original defect: for an anonymous session auth.uid() is
  -- NULL, so `user_id IS NULL` matched and anon could write platform rows.
  SELECT count(*), count(*) FILTER (WHERE 0 = ANY(polroles))
    INTO policy_count, bad_roles
  FROM pg_policy WHERE polrelid = 'public.agent_memory'::regclass;

  IF policy_count = 0 THEN
    RAISE EXCEPTION 'ISOLATION: agent_memory has no RLS policies at all';
  END IF;
  IF bad_roles <> 0 THEN
    RAISE EXCEPTION 'ISOLATION: % agent_memory policies apply to PUBLIC (includes anon)', bad_roles;
  END IF;

  -- ── 8. Write policies carry WITH CHECK ─────────────────────────────────────
  -- An UPDATE policy with only USING lets a row be edited into another tenant's
  -- ownership; INSERT with only USING is not enforcement at all.
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.agent_memory'::regclass
      AND polcmd IN ('a', 'w')            -- INSERT, UPDATE
      AND polwithcheck IS NULL
  ) THEN
    RAISE EXCEPTION 'ISOLATION: an INSERT/UPDATE policy on agent_memory has no WITH CHECK';
  END IF;

  -- Success is reported by RAISEing, for two reasons. It rolls back the probe
  -- INSERTs/UPDATEs above rather than trusting that each was rejected — nothing
  -- from this script can ever persist. And it makes the result explicit: the
  -- caller asserts on the marker string. A DO block that returns silently is
  -- indistinguishable from one that exited early, so silence must not mean pass.
  RAISE EXCEPTION 'AGENT_MEMORY_ISOLATION_PASS 8/8 (tenant_a=%, tenant_b=%, own_rows=%)',
    tenant_a, tenant_b, own_rows;
END $$;
