-- Local stand-ins for the platform objects our migrations depend on but never create.
--
-- A hosted Supabase database ships with the `auth` schema, the anon/authenticated/
-- service_role roles, pg_cron, pg_net, Vault and Storage. Our migrations reference
-- all of them — auth.uid() alone appears 53 times across 13 files, every one inside
-- a CREATE POLICY, which Postgres resolves at DDL time rather than at query time.
-- Against a bare Postgres those are hard errors, and the migration set cannot be
-- replayed at all.
--
-- THIS FILE IS A TEST FIXTURE. It is never applied to a real Supabase project —
-- there the genuine platform objects already exist, and these stubs would shadow
-- them. scripts/rehearse-migrations.sh applies it to a throwaway database only.
--
-- Fidelity rule: stubs match the hosted originals' *types and signatures*, not
-- their behaviour. The rehearsal proves the DDL is valid and the schema rebuilds;
-- it does not prove a cron fires or an HTTP call lands.

-- ── Roles ──────────────────────────────────────────────────────────────────
-- Roles are cluster-wide, not per-database, so a bare CREATE ROLE fails the
-- second time this runs against the same cluster.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

-- ── Extensions ─────────────────────────────────────────────────────────────
-- `extensions` exists because 20260406_auto_reflect_cron.sql does
-- `CREATE EXTENSION ... WITH SCHEMA extensions`. pgcrypto backs gen_random_uuid(),
-- used by 14 tables; it is built in from PG13 but creating it explicitly keeps the
-- rehearsal honest on older images.
CREATE SCHEMA IF NOT EXISTS extensions;
-- Into `extensions`, not `public`, exactly as Supabase installs it. In public
-- it added 36 functions to the public-schema count the rehearsal asserts on.
-- gen_random_uuid() still resolves: it is core since PG13, not pgcrypto-only.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── Realtime publication ───────────────────────────────────────────────────
-- Supabase creates `supabase_realtime` on every project; migrations add tables
-- to it with ALTER PUBLICATION so the frontend can subscribe. Without it the
-- very first migration fails on `publication "supabase_realtime" does not exist`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$$;

-- ── auth ───────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;

-- Minimal stand-in for GoTrue's auth.users, carrying only the columns our
-- migrations reference: `id` as an FK target for profiles and trade_lessons,
-- `created_at` for the 20260524 backfill's ORDER BY, and the metadata columns
-- for completeness. Types match the hosted originals so type-sensitive SQL
-- fails here the same way it would in production.
CREATE TABLE IF NOT EXISTS auth.users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_app_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- On hosted Supabase these read the request JWT that PostgREST injects. Locally
-- there is no request context, so they resolve the same GUCs PostgREST would set,
-- which keeps every RLS policy calling them both syntactically and semantically
-- valid.
--
-- Two details are load-bearing and must not be "simplified":
--   * current_setting(..., true) — the `true` is missing_ok. Without it these
--     throw whenever the GUC is unset, which locally is always.
--   * nullif(..., '') before every cast — an unset GUC comes back as the empty
--     string, and ''::uuid is a cast error, not NULL.
CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true));
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO anon, authenticated, service_role;

-- ── cron (pg_cron stand-in) ────────────────────────────────────────────────
-- pg_cron needs shared_preload_libraries and a server restart, so it cannot be
-- installed into a throwaway container. These stubs exist because the migrations
-- both *call* cron functions and *select from* cron tables inside view and
-- function bodies — public.cron_health() reads cron.job and cron.job_run_details,
-- and public.agent_cron_health selects from it, so both are resolved at CREATE
-- time and fail without these.
CREATE SCHEMA IF NOT EXISTS cron;

CREATE TABLE IF NOT EXISTS cron.job (
  jobid    bigserial PRIMARY KEY,
  schedule text NOT NULL,
  command  text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT 5432,
  database text NOT NULL DEFAULT current_database(),
  username text NOT NULL DEFAULT current_user,
  active   boolean NOT NULL DEFAULT true,
  jobname  text UNIQUE
);

CREATE TABLE IF NOT EXISTS cron.job_run_details (
  jobid          bigint,
  runid          bigserial PRIMARY KEY,
  job_pid        integer,
  database       text,
  username       text,
  command        text,
  status         text,
  return_message text,
  start_time     timestamptz,
  end_time       timestamptz
);

-- Upsert on jobname, mirroring pg_cron: re-scheduling an existing name replaces
-- it rather than erroring. Several migrations re-register the same job.
--
-- Parameters are p_-prefixed on purpose. Naming them `schedule` and `command`
-- collides with cron.job's own column names, and plpgsql substitutes matching
-- identifiers into the query text — which turned the ON CONFLICT clause into a
-- syntax error at first call rather than at CREATE time. Callers use positional
-- notation, so the names are free to differ from pg_cron's.
CREATE OR REPLACE FUNCTION cron.schedule(p_job_name text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command)
  VALUES (p_job_name, p_schedule, p_command)
  ON CONFLICT (jobname) DO UPDATE
    SET schedule = excluded.schedule, command = excluded.command
  RETURNING jobid;
$$;

CREATE OR REPLACE FUNCTION cron.schedule(p_schedule text, p_command text)
RETURNS bigint LANGUAGE sql AS $$
  SELECT cron.schedule('job-' || md5(p_schedule || p_command), p_schedule, p_command);
$$;

-- Real pg_cron raises when the name is absent; 20260428_fix_auto_reflect_cron.sql
-- calls this unguarded. The stub returns quietly so the rehearsal exercises the
-- rest of the file rather than stopping on an ordering accident.
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text)
RETURNS boolean LANGUAGE sql AS $$
  DELETE FROM cron.job WHERE jobname = job_name; SELECT true;
$$;

CREATE OR REPLACE FUNCTION cron.unschedule(job_id bigint)
RETURNS boolean LANGUAGE sql AS $$
  DELETE FROM cron.job WHERE jobid = job_id; SELECT true;
$$;

-- Parameter names matter: 20260525_stagger_cron_schedules.sql calls this with
-- named notation, `cron.alter_job(<jobid>, schedule := '...')`.
CREATE OR REPLACE FUNCTION cron.alter_job(
  job_id   bigint,
  schedule text    DEFAULT NULL,
  command  text    DEFAULT NULL,
  database text    DEFAULT NULL,
  username text    DEFAULT NULL,
  active   boolean DEFAULT NULL
)
RETURNS void LANGUAGE sql AS $$
  UPDATE cron.job j SET
    schedule = coalesce(alter_job.schedule, j.schedule),
    command  = coalesce(alter_job.command,  j.command),
    database = coalesce(alter_job.database, j.database),
    username = coalesce(alter_job.username, j.username),
    active   = coalesce(alter_job.active,   j.active)
  WHERE j.jobid = alter_job.job_id;
$$;

GRANT USAGE ON SCHEMA cron TO service_role;

-- ── net (pg_net stand-in) ──────────────────────────────────────────────────
-- Every call site sits inside a plpgsql body or a cron command string, so these
-- are never resolved at DDL time — stubbed so that a rehearsal which *does*
-- invoke a function fails on missing data rather than a missing schema.
CREATE SCHEMA IF NOT EXISTS net;

CREATE TABLE IF NOT EXISTS net.http_request_queue (
  id      bigserial PRIMARY KEY,
  method  text,
  url     text,
  headers jsonb,
  body    jsonb,
  timeout_milliseconds integer
);

CREATE OR REPLACE FUNCTION net.http_post(
  url     text,
  body    jsonb   DEFAULT '{}'::jsonb,
  params  jsonb   DEFAULT '{}'::jsonb,
  headers jsonb   DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  VALUES ('POST', http_post.url, http_post.headers, http_post.body, http_post.timeout_milliseconds)
  RETURNING id;
$$;

GRANT USAGE ON SCHEMA net TO service_role;

-- ── vault ──────────────────────────────────────────────────────────────────
-- Read by 37 sites, all resolving service_role_key / SUPABASE_URL. Empty by
-- design: a rebuilt database has no secrets, and the functions that read this
-- are written to skip when the lookup returns NULL.
CREATE SCHEMA IF NOT EXISTS vault;

CREATE TABLE IF NOT EXISTS vault.decrypted_secrets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text UNIQUE,
  description      text,
  secret           text,
  decrypted_secret text,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

GRANT USAGE ON SCHEMA vault TO service_role;

-- ── storage ────────────────────────────────────────────────────────────────
-- 20260520_avatars_storage_policies.sql is entirely CREATE POLICY ON
-- storage.objects and calls storage.foldername(name).
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id     text PRIMARY KEY,
  name   text NOT NULL,
  public boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id  text REFERENCES storage.buckets(id),
  name       text,
  owner      uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  metadata   jsonb
);

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Splits an object path into its segments, exactly as the platform does — the
-- avatars policies index [1] to compare the first folder against auth.uid().
CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT string_to_array(name, '/');
$$;

INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

-- ── public schema grants ───────────────────────────────────────────────────
-- Supabase grants these by default on a hosted project; several migrations
-- assume the roles can already see the schema.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ── supabase_migrations ────────────────────────────────────────────────────
-- Not referenced by any migration, but CI's runner records applied versions here.
-- Present so a rehearsed database matches the shape the runner expects.
CREATE SCHEMA IF NOT EXISTS supabase_migrations;

CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version    text PRIMARY KEY,
  statements text[],
  name       text
);
