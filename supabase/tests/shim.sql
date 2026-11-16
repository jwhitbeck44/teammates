-- Local stand-in for the parts of Supabase the migrations depend on, plus test helpers.
-- Loaded once into the template database before the migrations.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema extensions;
create schema auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz default now()
);

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create function auth.role() returns text language sql stable as $$
  select nullif(auth.jwt() ->> 'role', '')
$$;

grant usage on schema auth, extensions to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant select on auth.users to service_role;

-- Supabase hands out broad default privileges on new objects in public. Reproduce that so
-- the grants migration has something real to revoke.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Test helpers (schema t). Every assertion prints "ok - <message>" as a NOTICE;
-- run.sh counts those lines. A failed assertion raises an exception.
-- ---------------------------------------------------------------------------
create schema t;
grant usage on schema t to public;

create function t.ok(p_msg text) returns void language plpgsql as $$
begin raise notice 'ok - %', p_msg; end $$;

create function t.eq(p_actual text, p_expected text, p_msg text) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL - %: expected [%] got [%]', p_msg, p_expected, p_actual;
  end if;
  raise notice 'ok - %', p_msg;
end $$;

create function t.is_true(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL - %', p_msg; end if;
  raise notice 'ok - %', p_msg;
end $$;

-- Run a statement and require that it raises p_code (matched against the message, or the
-- SQLSTATE when p_code is five characters of digits/capitals such as 42501).
create function t.throws(p_sql text, p_code text, p_msg text default null) returns void
language plpgsql as $$
declare v_label text := coalesce(p_msg, p_sql);
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm = p_code or sqlstate = p_code then
      raise notice 'ok - % (raises %)', v_label, p_code;
      return;
    end if;
    raise exception 'FAIL - %: expected error [%] got [%] (sqlstate %)', v_label, p_code, sqlerrm, sqlstate;
  end;
  raise exception 'FAIL - %: expected error [%] but statement succeeded', v_label, p_code;
end $$;

create function t.lives(p_sql text, p_msg text default null) returns void language plpgsql as $$
declare v_label text := coalesce(p_msg, p_sql);
begin
  begin
    execute p_sql;
  exception when others then
    raise exception 'FAIL - %: unexpected error [%] (sqlstate %)', v_label, sqlerrm, sqlstate;
  end;
  raise notice 'ok - %', v_label;
end $$;

-- Identity switching. Both are SECURITY INVOKER; SET ROLE works because the session user is a superuser.
create function t.as_user(p_id uuid, p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_id, 'email', p_email, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;

create function t.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
end $$;

create function t.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  execute 'set local role service_role';
end $$;

create function t.reset() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

grant execute on all functions in schema t to public;

-- Number of rows a statement affected
create function t.affected(p_sql text) returns int language plpgsql as $$
declare n int;
begin execute p_sql; get diagnostics n = row_count; return n; end $$;
grant execute on function t.affected(text) to public;
