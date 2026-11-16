-- Independent review: assertions for areas that were checked and found fine (BUILD_NOTES/07-review.md,
-- "Checked and found fine"). These are additional to security.test.sql and should keep passing after fixes.
\set ON_ERROR_STOP on
begin;
\ir seed.sql

create table t.rc (k text primary key, v uuid);
grant select on t.rc to public;

-- ---------------------------------------------------------------------------
-- 1. Malformed answers for every question type fail with a plain error code (SQLSTATE P0001), never an
--    internal Postgres error such as 22P02 or 22003.
-- ---------------------------------------------------------------------------
create table t.fz (ty text, recip text, details jsonb, bad jsonb);
insert into t.fz
select ty, recip, details, b.value
from (values
  ('text', 'own_team_members', '{}'::jsonb,
    '[{"text":5},{"text":null},[],"str",{"text":"  "},{},null,{"text":["a"]}]'::jsonb),
  ('mcq', 'own_team_members', '{"choices":["A","B"],"otherEnabled":false}',
    '[{"choice":5},{"choice":"A","other":"x"},{},{"other":"x"},{"choice":null},{"choice":"Z"},"A"]'),
  ('msq', 'own_team_members', '{"choices":["A","B","C"],"otherEnabled":false,"minSelectable":1,"maxSelectable":2}',
    '[{"choices":"A"},{"choices":["A","A"]},{"choices":[1]},{"choices":["Z"]},{"choices":["A","B","C"]},{"choices":null},{}]'),
  ('numscale', 'own_team_members', '{"min":1,"max":5,"step":1}',
    '[{"value":"3"},{"value":1e400},{"value":null},{"value":3.5},{"value":0},{"value":-1e400},{"value":[3]},{}]'),
  ('constsum_options', 'own_team_members', '{"options":["x","y","z"],"points":10,"pointsPerOption":false,"distribute":"none"}',
    '[{"points":[1,2]},{"points":[1.5,2.5,6]},{"points":"x"},{"points":[-1,5,6]},{"points":[1e400,0,0]},{"points":[null,1,9]},{"points":{}}]'),
  ('constsum_recipients', 'own_team_members', '{"points":10,"pointsPerOption":false,"distribute":"none"}',
    '[{"points":1.5},{"points":"5"},{"points":-3},{"points":1e400},{"points":null},{}]'),
  ('contrib', 'own_team_members_including_self', '{"isZeroSum":false,"isNotSureAllowed":false}',
    '[{"value":100.5},{"value":-101},{"value":"100"},{"value":205},{"value":1e400},{"value":null},{"value":-5},{"value":101}]'),
  ('rubric', 'own_team_members', '{"choices":["a","b"],"subQuestions":["q1"],"descriptions":[["d1","d2"]]}',
    '[{"choices":[0.5]},{"choices":[5]},{"choices":["a"]},{"choices":[-1]},{"choices":[]},{"choices":"0"},{"choices":[null]}]'),
  ('rank_options', 'own_team_members', '{"options":["x","y","z"],"duplicatesAllowed":false}',
    '[{"ranks":[1,1,null]},{"ranks":[0,1,2]},{"ranks":"x"},{"ranks":[1.5,2,3]},{"ranks":[null,null,null]},{"ranks":[1,2]},{"ranks":[1e400,1,2]}]'),
  ('rank_recipients', 'own_team_members', '{"duplicatesAllowed":false}',
    '[{"rank":0},{"rank":1.5},{"rank":"1"},{"rank":1e400},{"rank":null},{}]')
) x(ty, recip, details, bad), jsonb_array_elements(x.bad) b;
grant select on t.fz to public;

do $$
declare
  s uuid := t.mk_session('rc-fz', interval '-1 day', interval '1 day');
  r record; q uuid; n int := 0; bad_state text; bad_msg text; v_rows jsonb;
  i int := 0;
begin
  insert into t.rc values ('fzs', s);
  for r in select distinct ty, recip, details from t.fz loop
    i := i + 1;
    q := t.mk_q(s, i, r.ty, r.recip, r.details);
    insert into t.rc values ('fzq_' || r.ty, q);
  end loop;
end $$;

select t.as_anon();
do $$
declare
  r record; v_q uuid; n int := 0; v_state text; v_msg text; v_ans jsonb;
  v_sess uuid := (select v from t.rc where k = 'fzs');
begin
  for r in select * from t.fz loop
    v_q := (select v from t.rc where k = 'fzq_' || r.ty);
    -- the same bad answer for the first one or two recipients (rank/constsum need rows to evaluate)
    v_ans := jsonb_build_array(
      jsonb_build_object('recipient_key', 's:' || t.id('Bob')::text, 'answer', r.bad));
    if r.ty = 'contrib' then
      v_ans := v_ans || jsonb_build_object('recipient_key', 's:' || t.id('Alice')::text, 'answer', r.bad);
    end if;
    begin
      perform public.student_submit(t.tok('Alice'), v_sess, v_q, v_ans);
      raise exception 'FAIL - % accepted bad answer %', r.ty, r.bad;
    exception when others then
      v_state := sqlstate; v_msg := sqlerrm;
      if v_msg like 'FAIL - %' then raise; end if;
      if v_state <> 'P0001' or v_msg !~ '^[a-z_]+$' then
        raise exception 'FAIL - % bad answer % produced internal error [%] %', r.ty, r.bad, v_state, v_msg;
      end if;
      n := n + 1;
    end;
  end loop;
  perform t.is_true(n = (select count(*) from t.fz), 'all ' || n || ' malformed answers rejected with a plain code');
end $$;
select t.reset();

-- the same body shapes that are NOT answers
select t.as_anon();
do $$
declare v_sess uuid := (select v from t.rc where k = 'fzs'); v_q uuid := (select v from t.rc where k = 'fzq_text'); r text;
begin
  foreach r in array array['null', '{}', '"x"', '5', '[1]', '[null]', '[{"recipient_key":5}]', '[{"recipient_key":"s:x","answer":{"text":"a"}}]', '[{"answer":{"text":"a"}}]'] loop
    begin
      perform public.student_submit(t.tok('Alice'), v_sess, v_q, r::jsonb);
      raise exception 'FAIL - body % accepted', r;
    exception when others then
      if sqlerrm like 'FAIL - %' then raise; end if;
      if sqlstate <> 'P0001' or sqlerrm !~ '^[a-z_]+$' then raise exception 'FAIL - body % gave internal error [%] %', r, sqlstate, sqlerrm; end if;
    end;
  end loop;
  perform t.ok('malformed top-level bodies are rejected with plain codes');
end $$;
select t.reset();

-- ---------------------------------------------------------------------------
-- 2. Recipient, giver, course and deadline checks
-- ---------------------------------------------------------------------------
select t.as_anon();
select t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Alice'), (select v from t.rc where k = 'fzs'), (select v from t.rc where k = 'fzq_text'),
  jsonb_build_array(t.row(t.sk('Dave'), '{"text":"x"}'))::text), 'not_a_recipient', 'cannot answer about a student outside the resolved list (other team)');
select t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Alice'), (select v from t.rc where k = 'fzs'), (select v from t.rc where k = 'fzq_text'),
  jsonb_build_array(t.row(t.sk('Alice'), '{"text":"x"}'))::text), 'not_a_recipient', 'cannot answer about self when the path excludes self');
select t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Alice'), (select v from t.rc where k = 'fzs'), (select v from t.rc where k = 'fzq_text'),
  jsonb_build_array(t.row(t.sk('Zed'), '{"text":"x"}'))::text), 'not_a_recipient', 'cannot answer about a student of another course');
select t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Alice'), (select v from t.rc where k = 'fzs'), (select v from t.rc where k = 'fzq_text'),
  jsonb_build_array(t.row('t:S1|T1', '{"text":"x"}'))::text), 'not_a_recipient', 'cannot use a team key on a student path');
select t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Alice'), (select v from t.rc where k = 'fzs'), (select v from t.rc where k = 'fzq_text'),
  jsonb_build_array(t.row(t.sk('Bob'), '{"text":"x"}'), t.row(t.sk('Bob'), '{"text":"y"}'))::text), 'duplicate_recipient', 'duplicate recipient rows rejected');
select t.reset();

-- session of another course, not yet open, closed and after grace
do $$
declare
  sb uuid := t.mk_session('rc-b', interval '-1 day', interval '1 day', 15, 'later', 'B');
  sf uuid := t.mk_session('rc-future', interval '1 hour', interval '2 days');
  sc uuid := t.mk_session('rc-closed', interval '-2 days', interval '-1 hour', 15);
  sg uuid := t.mk_session('rc-grace', interval '-2 days', interval '-5 minutes', 15);
begin
  insert into t.rc values ('sb', sb), ('sf', sf), ('sc', sc), ('sg', sg),
    ('qf', t.mk_q(sf, 1, 'text', 'own_team_members')), ('qc', t.mk_q(sc, 1, 'text', 'own_team_members')),
    ('qg', t.mk_q(sg, 1, 'text', 'own_team_members')), ('qb', t.mk_q(sb, 1, 'text', 'self'));
end $$;
select t.as_anon();
select t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Alice'), (select v from t.rc where k = 'sf'), (select v from t.rc where k = 'qf'), '[]'), 'not_open_yet', 'not open yet');
select t.throws(format('select public.student_get_session(%L, %L)', t.tok('Alice'), (select v from t.rc where k = 'sf')), 'not_open_yet', 'session payload before opening');
select t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Alice'), (select v from t.rc where k = 'sc'), (select v from t.rc where k = 'qc'), '[]'), 'deadline_passed', 'after grace, even an empty save is refused');
select t.lives(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Alice'), (select v from t.rc where k = 'sg'), (select v from t.rc where k = 'qg'),
  jsonb_build_array(t.row(t.sk('Bob'), '{"text":"in grace"}'))::text), 'inside the grace period saving works');
-- a question id from another session or course with my own session id
select t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Alice'), (select v from t.rc where k = 'sg'), (select v from t.rc where k = 'qc'), '[]'), 'not_found', 'question of another session of the same course');
select t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Alice'), (select v from t.rc where k = 'sg'), (select v from t.rc where k = 'qb'), '[]'), 'not_found', 'question of another course');
select t.reset();
-- an extension shorter than the grace period does not shorten it; an extension past it is honoured
do $$ begin
  insert into public.deadline_extensions (session_id, student_id, closes_at)
  values ((select v from t.rc where k = 'sc'), t.id('Bob'), now() - interval '30 minutes');
end $$;
select t.as_anon();
select t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Bob'), (select v from t.rc where k = 'sc'), (select v from t.rc where k = 'qc'), '[]'), 'deadline_passed', 'a pointless extension does not reopen a closed session');
select t.reset();
update public.deadline_extensions set closes_at = now() + interval '1 hour' where student_id = t.id('Bob');
select t.as_anon();
select t.lives(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Bob'), (select v from t.rc where k = 'sc'), (select v from t.rc where k = 'qc'), '[]'), 'extension reopens only that student');
select t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Carol'), (select v from t.rc where k = 'sc'), (select v from t.rc where k = 'qc'), '[]'), 'deadline_passed', 'teammate still closed');
select t.reset();

-- ---------------------------------------------------------------------------
-- 3. Catalog checks: grants, column privileges, executable functions
-- ---------------------------------------------------------------------------
select t.eq((select count(*)::text from information_schema.column_privileges where grantee = 'anon' and table_schema = 'public'), '0', 'anon holds no column privilege in public');
select t.eq((select count(*)::text from information_schema.table_privileges where grantee in ('anon', 'public') and table_schema = 'public'), '0', 'anon / public hold no table privilege in public');
select t.eq((select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')),
  'can_create_course,claim_instructor_invites,copy_session,enroll_students,has_perm,instructor_contrib_results,instructor_get_submission,instructor_moderate,instructor_preview,instructor_student_links,instructor_submit,jwt_email,new_access_token,publish_session,regenerate_student_token,session_course,student_get_results,student_get_session,student_portal,student_submit,unpublish_session',
  'authenticated may execute exactly the expected functions');
select t.eq((select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and has_function_privilege('public', p.oid, 'execute')), null, 'PUBLIC may execute no function in public');
select t.is_true(not has_table_privilege('authenticated', 'public.responses', 'insert')
  and not has_table_privilege('authenticated', 'public.responses', 'update')
  and not has_table_privilege('authenticated', 'public.responses', 'delete')
  and not has_table_privilege('authenticated', 'public.email_log', 'insert')
  and not has_table_privilege('authenticated', 'public.instructor_allowlist', 'select'), 'authenticated has no write on responses/email_log and no read on allowlist');
select t.is_true(not has_column_privilege('authenticated', 'public.students', 'access_token', 'insert')
  and not has_column_privilege('authenticated', 'public.students', 'access_token', 'update')
  and not has_column_privilege('authenticated', 'public.students', 'course_id', 'update')
  and not has_column_privilege('authenticated', 'public.sessions', 'course_id', 'update')
  and not has_column_privilege('authenticated', 'public.sessions', 'published_at', 'insert')
  and not has_column_privilege('authenticated', 'public.sessions', 'published_at', 'update')
  and not has_column_privilege('authenticated', 'public.sessions', 'opened_email_sent_at', 'update')
  and not has_column_privilege('authenticated', 'public.sessions', 'closing_email_sent_at', 'update')
  and not has_column_privilege('authenticated', 'public.sessions', 'published_email_sent_at', 'update')
  and not has_column_privilege('authenticated', 'public.questions', 'session_id', 'update')
  and not has_column_privilege('authenticated', 'public.course_instructors', 'user_id', 'insert')
  and not has_column_privilege('authenticated', 'public.course_instructors', 'user_id', 'update')
  and not has_column_privilege('authenticated', 'public.course_instructors', 'email', 'update')
  and not has_column_privilege('authenticated', 'public.course_instructors', 'course_id', 'update')
  and not has_column_privilege('authenticated', 'public.courses', 'created_by', 'update'), 'server-managed columns cannot be written by clients');
select t.eq((select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.prosecdef and not coalesce(p.proconfig::text like '%search_path=public, pg_temp%' or p.proconfig::text like '%search_path=public, extensions, pg_temp%', false)),
  '0', 'every SECURITY DEFINER function pins search_path with pg_temp last');

-- ---------------------------------------------------------------------------
-- 4. Cross-course writes through the remaining grants
-- ---------------------------------------------------------------------------
select t.as_user(t.id('owner'), 'owner@a.edu');
do $$ begin
  insert into public.deadline_extensions (session_id, student_id, closes_at)
  values ((select v from t.rc where k = 'sg'), t.id('Alice'), now() + interval '1 day');
end $$;
select t.throws(format('update public.deadline_extensions set student_id = %L where student_id = %L', t.id('Zed'), t.id('Alice')), 'not_found', 'extension cannot be re-pointed at a student of another course');
do $$ begin
  begin
    execute format('update public.deadline_extensions set session_id = %L where student_id = %L', (select v from t.rc where k = 'sb'), t.id('Alice'));
    raise exception 'FAIL - extension moved into another course session';
  exception when others then
    if sqlerrm like 'FAIL - %' then raise; end if;
    perform t.ok('extension cannot be moved into another course session (' || sqlerrm || ')');
  end;
end $$;
select t.throws(format('update public.questions set session_id = %L where id = %L', (select v from t.rc where k = 'sb'), (select v from t.rc where k = 'qc')), '42501', 'question cannot be moved to another session');
select t.throws(format('insert into public.questions (session_id, number, type, brief, giver_type, recipient_type) values (%L, 5, ''text'', ''x'', ''students'', ''self'')', (select v from t.rc where k = 'sb')), '42501', 'question insert into course B refused');
select t.throws($$insert into public.course_instructors (course_id, email, display_name, role, user_id) values (t.id('A'), 'x@a.edu', 'X', 'observer', t.id('stranger'))$$, '42501', 'invite cannot carry a forged user_id');
select t.throws($$insert into public.courses (code, name, created_by) values ('Z', 'Z', t.id('bowner'))$$, '42501', 'course cannot be created in someone else''s name');
select t.throws($$insert into public.students (course_id, name, email, access_token) values (t.id('A'), 'Eve', 'eve@s.edu', 'known')$$, '42501', 'student cannot be created with a chosen token');
select t.throws(format('insert into public.sessions (course_id, name, opens_at, closes_at, published_at) values (%L, ''pp'', now(), now() + interval ''1 day'', now())', t.id('A')), '42501', 'session cannot be created already published');
-- roster import: rows are written to the course in the argument only, even with a hostile row
select t.eq((public.enroll_students(t.id('A'), '[{"section":"S1","team":"T9","name":"New One","email":"zed@s.edu","comments":null,"course_id":"x"}]') ->> 'created'), '1', 'enroll creates a course A student with a course B email');
select t.eq((select course_id::text from public.students where email = 'zed@s.edu' and name = 'New One'), t.id('A')::text, 'the new row belongs to course A');
select t.eq((select name from public.students where id = t.id('Zed')), null, 'course B student invisible to the course A owner');
select t.reset();
select t.eq((select name from public.students where id = t.id('Zed')), 'Zed', 'course B student untouched by the course A import');

rollback;
