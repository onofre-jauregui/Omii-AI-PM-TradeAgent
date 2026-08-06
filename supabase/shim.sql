-- Supabase compatibility shim for a bare Postgres container.
--
-- The migrations in supabase/migrations/ are written against a hosted Supabase
-- project and reference objects Supabase provisions for you: the `auth` schema
-- and `auth.uid()`, the `anon`/`authenticated`/`service_role` roles, and the
-- `pg_cron` / `pg_net` extensions. A stock postgres:16 image has none of them, so
-- replaying the migrations there fails on the first RLS policy.
--
-- This file supplies just enough of that surface for the migrations to apply. It
-- is a REHEARSAL fixture, not a Supabase emulator — the goal is to prove every
-- migration parses, applies in order, and leaves the schema the code expects. It
-- deliberately does not reproduce Supabase's auth behaviour, and nothing here
-- ever runs against a real database.
--
-- When a migration fails during rehearsal, suspect this shim before the
-- migration: a missing column on auth.users looks identical to a broken
-- migration, and the fixture is far more likely to be incomplete.

-- ── Roles ────────────────────────────────────────────────────────────────────
-- Referenced by GRANT statements and RLS policies. NOLOGIN: nothing authenticates
-- as these in rehearsal, they only need to exist so GRANT resolves.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- ── Schemas ──────────────────────────────────────────────────────────────────
create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists cron;

grant usage on schema public to anon, authenticated, service_role;

-- ── Realtime publication ─────────────────────────────────────────────────────
-- Supabase creates `supabase_realtime` on every project; migrations add tables to
-- it with ALTER PUBLICATION so the frontend can subscribe to row changes.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- ── auth.users ───────────────────────────────────────────────────────────────
-- Seven migrations reference this table, mostly as a foreign-key target for
-- user_id columns. Columns mirror the ones those migrations actually touch.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── auth.uid() / auth.role() / auth.jwt() ────────────────────────────────────
-- 55 RLS policies call auth.uid(). In rehearsal there is no JWT, so these read a
-- session GUC that nothing sets and therefore return NULL — which is correct: the
-- rehearsal proves the policies *compile and attach*, not that they let the right
-- rows through. Row-level behaviour is covered by the integration tests against a
-- real Supabase, not here.
create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create or replace function auth.role() returns text
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;

create or replace function auth.jwt() returns jsonb
  language sql stable
  as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;

-- ── pg_cron surface ──────────────────────────────────────────────────────────
-- pg_cron is a Supabase-managed extension and cannot be installed in a stock
-- container. 30 migrations call cron.schedule() and several read cron.job. These
-- stubs record the schedule rather than running anything: rehearsal asserts the
-- migrations apply, and the health-check cron manifest is what verifies real jobs
-- exist in production.
create table if not exists cron.job (
  jobid bigserial primary key,
  schedule text,
  command text,
  nodename text default 'localhost',
  nodeport int default 5432,
  database text default current_database(),
  username text default current_user,
  active boolean default true,
  jobname text unique
);

create table if not exists cron.job_run_details (
  runid bigserial primary key,
  jobid bigint,
  job_pid int,
  database text,
  username text,
  command text,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
);

create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint language plpgsql as $$
declare new_id bigint;
begin
  insert into cron.job (jobname, schedule, command)
  values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid into new_id;
  return new_id;
end $$;

create or replace function cron.schedule(schedule text, command text)
returns bigint language plpgsql as $$
begin
  return cron.schedule('job_' || md5(command), schedule, command);
end $$;

create or replace function cron.unschedule(job_name text)
returns boolean language plpgsql as $$
begin
  delete from cron.job where jobname = job_name;
  return true;
end $$;

create or replace function cron.alter_job(
  job_id bigint,
  schedule text default null,
  command text default null,
  database text default null,
  username text default null,
  active boolean default null
) returns void language plpgsql as $$
begin
  update cron.job j set
    schedule = coalesce(alter_job.schedule, j.schedule),
    command  = coalesce(alter_job.command,  j.command),
    active   = coalesce(alter_job.active,   j.active)
  where j.jobid = job_id;
end $$;

-- ── pg_net surface ───────────────────────────────────────────────────────────
-- Migrations schedule cron jobs that call net.http_post to invoke edge functions.
-- The stub returns a request id and performs no network I/O — rehearsal must never
-- reach out, least of all to a production endpoint.
create schema if not exists net;

create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds int default 5000
) returns bigint language sql as $$ select 0::bigint $$;

create or replace function net.http_get(
  url text,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds int default 5000
) returns bigint language sql as $$ select 0::bigint $$;

-- ── Extensions the migrations expect to already exist ────────────────────────
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- `create extension pg_cron` / `pg_net` appear in the migrations. They cannot be
-- installed here, so shadow them with no-op stubs in a schema that precedes
-- pg_catalog on the search path is not possible — instead the rehearsal runner
-- strips those statements. See scripts/rehearse-migrations.sh.
