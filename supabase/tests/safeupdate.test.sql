-- Supabase loads pg-safeupdate for API requests: an UPDATE or DELETE without a WHERE clause fails
-- with "UPDATE requires a WHERE clause". This cluster does not load it, so the function tests cannot
-- catch it. This file checks the source of every function in public instead (migration 20261120000014).
\set ON_ERROR_STOP on
begin;
\ir seed.sql

-- Statements in p_src that are an UPDATE or DELETE with no WHERE at their own level.
-- Comments and string literals are dropped, then everything in parentheses (subqueries, calls,
-- conditions), then the text is split into statements at ';'.
create function t.unguarded_writes(p_src text) returns text[] language plpgsql as $$
declare s text; prev text; stmt text; bad text[] := '{}';
begin
  s := regexp_replace(p_src, '--[^\n]*', ' ', 'g');
  s := regexp_replace(s, '''[^'']*''', ' ', 'g');
  loop
    prev := s;
    s := regexp_replace(s, '\([^()]*\)', ' ', 'g');
    exit when s = prev;
  end loop;
  foreach stmt in array regexp_split_to_array(s, ';') loop
    if stmt ~* '(^|[^a-z0-9_.])(update\s+(only\s+)?[a-z0-9_."]+(\s+(as\s+)?[a-z0-9_]+)?\s+set|delete\s+from)\M'
       and stmt !~* '\mdo\s+update\M'
       and stmt !~* '\mwhere\M' then
      bad := bad || left(btrim(regexp_replace(stmt, '\s+', ' ', 'g')), 100);
    end if;
  end loop;
  return bad;
end $$;

-- The checker itself.
select t.is_true(cardinality(t.unguarded_writes(
  'begin update _enroll_in i set is_new = not exists (select 1 from s where s.e = i.e); end')) = 1,
  'checker flags an UPDATE whose only WHERE is inside a subquery');
select t.is_true(cardinality(t.unguarded_writes('delete from public.x;')) = 1,
  'checker flags a DELETE without WHERE');
select t.is_true(cardinality(t.unguarded_writes(
  'update _enroll_in i set is_new = not exists (select 1 from s where s.e = i.e) where true;')) = 0,
  'checker accepts where true');
select t.is_true(cardinality(t.unguarded_writes(
  'insert into t (a, b) values (1, 2) on conflict (a) do update set b = excluded.b;')) = 0,
  'checker ignores on conflict do update');
select t.is_true(cardinality(t.unguarded_writes(
  'if x then update public.s set a = 1 where id = p; end if; -- update y set z = 1;')) = 0,
  'checker ignores comments and guarded updates');

-- Every function in public.
do $$
declare bad text[] := '{}'; f record; b text[];
begin
  for f in
    select p.proname, p.prosrc from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and l.lanname in ('plpgsql', 'sql')
  loop
    b := t.unguarded_writes(f.prosrc);
    if cardinality(b) > 0 then
      bad := bad || (f.proname || ': ' || array_to_string(b, ' / '));
    end if;
  end loop;
  perform t.is_true(cardinality(bad) = 0,
    'every UPDATE and DELETE in public functions has a WHERE clause' ||
    coalesce(': ' || nullif(array_to_string(bad, ' | '), ''), ''));
end $$;

select t.is_true(exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'enroll_students' and p.prosrc ~ 'where true'),
  'enroll_students is the version from migration 20261120000014');
rollback;
