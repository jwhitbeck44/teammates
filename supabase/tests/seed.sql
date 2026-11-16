-- Shared fixture, included by each test with \ir seed.sql. Runs as superuser.
-- Users: owner (coowner of A), mgr, obs, tut (instructors of A), bowner (owner of B), stranger (nobody).
-- Course A students: Alice, Bob, Carol (S1/T1); Dave, Erin (S1/T2); Frank (S2/T3);
--                    Gina, Hal, Ivy, Jon (S2/T4). Course B student: Zed.

alter default privileges in schema t grant execute on functions to public;
grant select on all tables in schema t to public;
create table t.ids (name text primary key, id uuid not null);
create function t.id(p_name text) returns uuid language sql stable as $$ select id from t.ids where name = p_name $$;
create function t.tok(p_name text) returns text language sql stable security definer as
  $$ select access_token from public.students where id = t.id(p_name) $$;
create function t.tok_of_email(p_email text) returns text language sql stable security definer as
  $$ select access_token from public.students where email = p_email $$;
create function t.sk(p_name text) returns text language sql stable as $$ select 's:' || t.id(p_name)::text $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@a.edu'),
  ('00000000-0000-0000-0000-00000000000b', 'mgr@a.edu'),
  ('00000000-0000-0000-0000-00000000000c', 'obs@a.edu'),
  ('00000000-0000-0000-0000-00000000000d', 'tut@a.edu'),
  ('00000000-0000-0000-0000-00000000000e', 'bowner@b.edu'),
  ('00000000-0000-0000-0000-00000000000f', 'stranger@x.edu');
insert into t.ids values
  ('owner', '00000000-0000-0000-0000-00000000000a'), ('mgr', '00000000-0000-0000-0000-00000000000b'),
  ('obs', '00000000-0000-0000-0000-00000000000c'), ('tut', '00000000-0000-0000-0000-00000000000d'),
  ('bowner', '00000000-0000-0000-0000-00000000000e'), ('stranger', '00000000-0000-0000-0000-00000000000f'),
  ('A', '10000000-0000-0000-0000-00000000000a'), ('B', '10000000-0000-0000-0000-00000000000b');
insert into public.instructor_allowlist values ('owner@a.edu'), ('bowner@b.edu');

insert into public.courses (id, code, name, created_by) values
  (t.id('A'), 'MGMT1', 'Course A', t.id('owner')), (t.id('B'), 'MGMT2', 'Course B', t.id('bowner'));
insert into public.course_instructors (course_id, email, user_id, display_name, role) values
  (t.id('A'), 'mgr@a.edu', t.id('mgr'), 'Manager', 'manager'),
  (t.id('A'), 'obs@a.edu', t.id('obs'), 'Observer', 'observer'),
  (t.id('A'), 'tut@a.edu', t.id('tut'), 'Tutor', 'tutor');

create temp table _roster (name text, section text, team text, course text);
insert into _roster values
  ('Alice','S1','T1','A'), ('Bob','S1','T1','A'), ('Carol','S1','T1','A'),
  ('Dave','S1','T2','A'), ('Erin','S1','T2','A'), ('Frank','S2','T3','A'),
  ('Gina','S2','T4','A'), ('Hal','S2','T4','A'), ('Ivy','S2','T4','A'), ('Jon','S2','T4','A'),
  ('Zed','S1','TB','B');
with ins as (
  insert into public.students (course_id, section, team, name, email)
  select t.id(r.course), r.section, r.team, r.name, lower(r.name) || '@s.edu' from _roster r
  returning id, name)
insert into t.ids select name, id from ins;

-- Helpers to build sessions and questions
create function t.mk_session(p_name text, p_opens interval, p_closes interval, p_grace int default 15,
                             p_vis text default 'later', p_course text default 'A') returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into public.sessions (course_id, name, opens_at, closes_at, grace_minutes, results_visibility)
  values (t.id(p_course), p_name, now() + p_opens, now() + p_closes, p_grace, p_vis) returning id into v;
  return v;
end $$;

create function t.mk_q(p_session uuid, p_number int, p_type text, p_recip text, p_details jsonb default '{}',
                       p_giver text default 'students', p_resp text[] default '{}', p_gname text[] default '{}',
                       p_rname text[] default '{}', p_max int default null) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into public.questions (session_id, number, type, brief, giver_type, recipient_type, details,
                                show_responses_to, show_giver_name_to, show_recipient_name_to, max_recipients)
  values (p_session, p_number, p_type, 'Q' || p_number, p_giver, p_recip, p_details, p_resp, p_gname, p_rname, p_max)
  returning id into v;
  return v;
end $$;

-- Build the answers array: t.ans('Bob', '{"text":"hi"}', ...) pairs of key-name and answer json
create function t.row(p_recipient_key text, p_answer jsonb, p_comment text default null) returns jsonb
language sql immutable as $$
  select jsonb_build_object('recipient_key', p_recipient_key, 'answer', p_answer) ||
         case when p_comment is null then '{}'::jsonb else jsonb_build_object('giver_comment', p_comment) end
$$;

grant select on t.ids to public;
grant execute on all functions in schema t to public;
