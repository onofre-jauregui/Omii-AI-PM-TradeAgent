-- Catalog fingerprint of the public schema. Run identically against production
-- (Management API) and the rehearsal database so the two can be diffed line-for-line.
select json_build_object(
  'columns', (
    select coalesce(json_agg(x order by x), '[]'::json) from (
      select c.table_name || '.' || c.column_name || ' :: ' || c.data_type
             || case when c.is_nullable = 'NO' then ' NOT NULL' else '' end
             || coalesce(' DEFAULT ' || c.column_default, '') as x
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
       and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public'
    ) s
  ),
  'views', (
    select coalesce(json_agg(x order by x), '[]'::json) from (
      select table_name as x from information_schema.views where table_schema = 'public'
    ) s
  ),
  'routines', (
    select coalesce(json_agg(x order by x), '[]'::json) from (
      select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as x
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
    ) s
  ),
  'policies', (
    select coalesce(json_agg(x order by x), '[]'::json) from (
      select tablename || '::' || policyname as x from pg_policies where schemaname = 'public'
    ) s
  ),
  'indexes', (
    select coalesce(json_agg(x order by x), '[]'::json) from (
      select indexname as x from pg_indexes where schemaname = 'public'
    ) s
  ),
  'constraints', (
    select coalesce(json_agg(x order by x), '[]'::json) from (
      select rel.relname || '::' || con.conname || ' ' || con.contype::text as x
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
      where n.nspname = 'public'
    ) s
  ),
  'triggers', (
    select coalesce(json_agg(x order by x), '[]'::json) from (
      select c.relname || '::' || t.tgname as x
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname in ('public','auth')
    ) s
  )
) as catalog;
