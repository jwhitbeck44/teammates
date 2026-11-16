-- Access control: anon, cross-course, observer, tutor, manager, tokens, column grants, invites.
\set ON_ERROR_STOP on
begin;
\ir seed.sql

-- a session with one text question in A and one in B, plus an instructor-giver question
create table t.fix (k text primary key, v uuid);
do $$
declare sa uuid := t.mk_session('sec', interval '-1 day', interval '1 day');
        sb uuid := t.mk_session('secB', interval '-1 day', interval '1 day', 15, 'later', 'B');
begin
  insert into t.fix values ('sa', sa), ('sb', sb),
    ('qa', t.mk_q(sa, 1, 'text', 'own_team_members')),
    ('qb', t.mk_q(sb, 1, 'text', 'self'));
end $$;
grant select on t.fix to public;

-- ---------- anon ----------
select t.as_anon();
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    perform t.throws(format('select * from public.%I', r.tablename), '42501', 'anon cannot select ' || r.tablename);
  end loop;
end $$;
select t.throws('insert into public.students (course_id, name, email) values (t.id(''A''), ''x'', ''x@x.edu'')', '42501', 'anon cannot insert students');
select t.throws('select public.has_perm(t.id(''A''), ''read'')', '42501', 'anon cannot execute has_perm');
select t.throws('select public.enroll_students(t.id(''A''), ''[]'')', '42501', 'anon cannot execute enroll_students');
select t.throws('select public.publish_session(t.id(''A''))', '42501', 'anon cannot execute publish_session');
select t.throws('select * from public.question_recipients(null, null)', '42501', 'anon cannot execute question_recipients');
select t.throws('select public.validate_answers(null, null, null)', '42501', 'anon cannot execute validate_answers');
select t.throws('select public.contrib_team_result(null, null)', '42501', 'anon cannot execute contrib_team_result');
select t.throws('select public.student_by_token(''x'')', '42501', 'anon cannot execute student_by_token');
select t.throws('select public.claim_instructor_invites()', '42501', 'anon cannot execute claim_instructor_invites');
select t.throws('select public.student_portal(''nope'')', 'invalid_token', 'anon can run student_portal (bad token rejected)');
select t.reset();
-- every function anon can execute is a student_ function
select t.eq((select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')),
            'student_get_results,student_get_session,student_portal,student_submit', 'anon may execute only the four student RPCs');
-- every SECURITY DEFINER function pins search_path
select t.eq((select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.prosecdef and not coalesce(p.proconfig::text like '%search_path%', false)),
            '0', 'every SECURITY DEFINER function sets search_path');

-- ---------- student tokens ----------
select t.throws($$select public.student_portal('garbage')$$, 'invalid_token', 'portal: bad token');
select t.throws($$select public.student_get_session('garbage', t.id('A'))$$, 'invalid_token', 'get_session: bad token');
select t.throws($$select public.student_submit('garbage', t.id('A'), t.id('A'), '[]')$$, 'invalid_token', 'submit: bad token');
select t.throws($$select public.student_get_results('garbage', t.id('A'))$$, 'invalid_token', 'results: bad token');
select t.throws($$select public.student_portal(null)$$, 'invalid_token', 'portal: null token');
select t.throws($$select public.student_portal('')$$, 'invalid_token', 'portal: empty token');
select t.as_anon();
select t.throws(format('select public.student_get_session(%L, %L)', t.tok('Zed'), (select v from t.fix where k = 'sa')), 'not_found', 'course B token cannot open course A session');
select t.throws(format('select public.student_get_session(%L, %L)', t.tok('Alice'), (select v from t.fix where k = 'sb')), 'not_found', 'course A token cannot open course B session');
select t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Zed'), (select v from t.fix where k = 'sa'), (select v from t.fix where k = 'qa'), '[]'), 'not_found', 'course B token cannot submit to course A');
select t.throws(format('select public.student_get_results(%L, %L)', t.tok('Zed'), (select v from t.fix where k = 'sa')), 'not_found', 'course B token cannot read course A results');
select t.is_true(public.student_portal(t.tok('Alice')) #>> '{course,name}' = 'Course A', 'valid token works');
select t.is_true((public.student_portal(t.tok('Zed')) -> 'sessions') @> jsonb_build_array(jsonb_build_object('name', 'secB')), 'Zed sees only course B sessions');
select t.is_true(not ((public.student_portal(t.tok('Zed')) -> 'sessions') @> jsonb_build_array(jsonb_build_object('name', 'sec'))), 'Zed does not see course A sessions');
select t.reset();

-- ---------- instructor of A versus course B ----------
select t.as_user(t.id('owner'), 'owner@a.edu');
select t.eq((select count(*)::text from public.courses), '1', 'owner of A sees one course');
select t.eq((select count(*)::text from public.students where course_id = t.id('B')), '0', 'owner of A cannot read B students');
select t.eq((select count(*)::text from public.students), '10', 'owner of A reads A students');
select t.eq((select count(*)::text from public.sessions where course_id = t.id('B')), '0', 'owner of A cannot read B sessions');
select t.eq((select count(*)::text from public.questions q where q.session_id = (select v from t.fix where k = 'sb')), '0', 'owner of A cannot read B questions');
select t.eq((select count(*)::text from public.course_instructors where course_id = t.id('B')), '0', 'owner of A cannot read B instructors');
select t.throws($$insert into public.students (course_id, name, email) values (t.id('B'), 'Eve', 'eve@s.edu')$$, '42501', 'owner of A cannot insert B student');
select t.throws($$insert into public.sessions (course_id, name, opens_at, closes_at) values (t.id('B'), 'x', now(), now() + interval '1 day')$$, '42501', 'owner of A cannot insert B session');
select t.eq(t.affected($$update public.courses set name = 'hacked' where id = t.id('B')$$)::text, '0', 'owner of A cannot update course B');
select t.eq(t.affected($$delete from public.courses where id = t.id('B')$$)::text, '0', 'owner of A cannot delete course B');
select t.eq(t.affected($$update public.students set name = 'x' where course_id = t.id('B')$$)::text, '0', 'owner of A cannot update B students');
select t.eq(t.affected($$delete from public.students where course_id = t.id('B')$$)::text, '0', 'owner of A cannot delete B students');
select t.throws($$select public.enroll_students(t.id('B'), '[]')$$, 'forbidden', 'owner of A cannot enroll into B');
select t.throws(format('select public.publish_session(%L)', (select v from t.fix where k = 'sb')), 'forbidden', 'owner of A cannot publish B session');
select t.throws(format('select public.copy_session(%L, ''c'')', (select v from t.fix where k = 'sb')), 'forbidden', 'owner of A cannot copy B session');
select t.throws(format('select public.copy_session(%L, ''c'', %L)', (select v from t.fix where k = 'sa'), t.id('B')), 'forbidden', 'owner of A cannot copy into course B');
select t.throws(format('select public.regenerate_student_token(%L)', t.id('Zed')), 'forbidden', 'owner of A cannot regenerate B token');
select t.throws(format('select public.instructor_preview(%L, %L)', (select v from t.fix where k = 'sb'), t.id('Zed')), 'forbidden', 'owner of A cannot preview B');
select t.throws(format('select public.instructor_contrib_results(%L)', (select v from t.fix where k = 'qb')), 'forbidden', 'owner of A cannot read B contrib results');
select t.is_true(not public.has_perm(t.id('B'), 'read'), 'has_perm false for other course');
select t.is_true(public.has_perm(t.id('A'), 'modify_course'), 'has_perm true for coowner');
select t.reset();

-- ---------- observer cannot write ----------
select t.as_user(t.id('obs'), 'obs@a.edu');
select t.eq((select count(*)::text from public.students), '10', 'observer reads students');
select t.throws($$insert into public.students (course_id, name, email) values (t.id('A'), 'Eve', 'eve@s.edu')$$, '42501', 'observer cannot insert student');
select t.eq(t.affected($$update public.students set name = 'x' where course_id = t.id('A')$$)::text, '0', 'observer cannot update students');
select t.eq(t.affected($$delete from public.students where course_id = t.id('A')$$)::text, '0', 'observer cannot delete students');
select t.throws($$insert into public.sessions (course_id, name, opens_at, closes_at) values (t.id('A'), 'x', now(), now() + interval '1 day')$$, '42501', 'observer cannot insert session');
select t.eq(t.affected($$update public.sessions set name = 'x' where course_id = t.id('A')$$)::text, '0', 'observer cannot update sessions');
select t.throws(format('insert into public.questions (session_id, number, type, brief, giver_type, recipient_type, details) values (%L, 9, ''text'', ''b'', ''students'', ''self'', ''{}'')', (select v from t.fix where k = 'sa')), '42501', 'observer cannot insert question');
select t.eq(t.affected($$update public.courses set name = 'x' where id = t.id('A')$$)::text, '0', 'observer cannot update course');
select t.throws($$insert into public.course_instructors (course_id, email, display_name, role) values (t.id('A'), 'n@a.edu', 'N', 'observer')$$, '42501', 'observer cannot invite');
select t.throws($$select public.enroll_students(t.id('A'), '[]')$$, 'forbidden', 'observer cannot enroll');
select t.throws(format('select public.publish_session(%L)', (select v from t.fix where k = 'sa')), 'forbidden', 'observer cannot publish');
select t.throws(format('select public.instructor_moderate(%L, %L, %L, ''[]'')', (select v from t.fix where k = 'sa'), (select v from t.fix where k = 'qa'), t.id('Alice')), 'forbidden', 'observer cannot moderate');
select t.throws(format('select public.instructor_submit(%L, %L, ''[]'')', (select v from t.fix where k = 'sa'), (select v from t.fix where k = 'qa')), 'forbidden', 'observer cannot submit as instructor');
select t.throws(format('select public.regenerate_student_token(%L)', t.id('Alice')), 'forbidden', 'observer cannot regenerate token');
select t.is_true(public.has_perm(t.id('A'), 'view_results') and not public.has_perm(t.id('A'), 'submit'), 'observer perms: view yes, submit no');
select t.reset();

-- ---------- tutor, manager ----------
select t.as_user(t.id('tut'), 'tut@a.edu');
select t.is_true(public.has_perm(t.id('A'), 'submit') and not public.has_perm(t.id('A'), 'modify_students'), 'tutor perms: submit yes, modify_students no');
select t.throws($$insert into public.students (course_id, name, email) values (t.id('A'), 'Eve', 'eve@s.edu')$$, '42501', 'tutor cannot insert student');
select t.reset();
select t.as_user(t.id('mgr'), 'mgr@a.edu');
select t.lives($$insert into public.students (course_id, name, email) values (t.id('A'), 'Eve', 'eve@s.edu')$$, 'manager can insert student');
select t.lives($$insert into public.course_instructors (course_id, email, display_name, role) values (t.id('A'), 'n@a.edu', 'N', 'tutor')$$, 'manager can invite a tutor');
select t.throws($$insert into public.course_instructors (course_id, email, display_name, role) values (t.id('A'), 'c2@a.edu', 'C2', 'coowner')$$, '42501', 'manager cannot invite a coowner');
select t.throws($$update public.course_instructors set role = 'coowner' where email = 'mgr@a.edu'$$, '42501', 'manager cannot promote self to coowner');
select t.eq(t.affected($$update public.courses set name = 'x' where id = t.id('A')$$)::text, '0', 'manager cannot update course');
select t.eq(t.affected($$delete from public.courses where id = t.id('A')$$)::text, '0', 'manager cannot delete course');
select t.eq(t.affected($$delete from public.course_instructors where email = 'owner@a.edu'$$)::text, '0', 'manager cannot remove a coowner');
select t.lives(format('select public.publish_session(%L)', (select v from t.fix where k = 'sa')), 'manager can publish');
select t.reset();

-- ---------- column and table grants ----------
select t.as_user(t.id('owner'), 'owner@a.edu');
select t.throws($$update public.students set access_token = 'mine' where name = 'Alice'$$, '42501', 'cannot write access_token directly');
select t.throws($$update public.course_instructors set user_id = null where email = 'mgr@a.edu'$$, '42501', 'cannot write user_id directly');
select t.throws(format('update public.sessions set published_at = now() where id = %L', (select v from t.fix where k = 'sb')), '42501', 'cannot write published_at directly');
select t.throws(format('update public.sessions set opened_email_sent_at = now() where id = %L', (select v from t.fix where k = 'sa')), '42501', 'cannot write email stamps directly');
select t.throws(format('insert into public.responses (session_id, question_id, giver_key, recipient_key, answer) values (%L, %L, ''a'', ''b'', ''{}'')', (select v from t.fix where k = 'sa'), (select v from t.fix where k = 'qa')), '42501', 'instructors cannot insert responses');
select t.throws($$update public.responses set answer = '{}'$$, '42501', 'instructors cannot update responses');
select t.throws($$delete from public.responses$$, '42501', 'instructors cannot delete responses');
select t.throws($$select * from public.instructor_allowlist$$, '42501', 'authenticated cannot read allowlist');
select t.throws($$insert into public.instructor_allowlist values ('me@x.edu')$$, '42501', 'authenticated cannot write allowlist');
select t.throws($$insert into public.email_log (kind, to_email, status) values ('x', 'a@b.c', 'sent')$$, '42501', 'authenticated cannot write email_log');
select t.lives($$select count(*) from public.email_log$$, 'instructor can read email_log (empty)');
select t.reset();

-- ---------- course creation and allowlist ----------
select t.as_user(t.id('stranger'), 'stranger@x.edu');
select t.throws($$insert into public.courses (code, name) values ('X', 'Not allowed')$$, '42501', 'non-allowlisted user cannot create a course');
select t.eq((select count(*)::text from public.courses), '0', 'stranger sees no courses');
select t.reset();
select t.as_user(t.id('bowner'), 'bowner@b.edu');
select t.lives($$insert into public.courses (code, name) values ('NEW', 'Brand new')$$, 'allowlisted user can create a course');
select t.eq((select role from public.course_instructors ci join public.courses c on c.id = ci.course_id where c.code = 'NEW'), 'coowner', 'creator became coowner');
select t.throws($$insert into public.courses (code, name, time_zone) values ('TZ', 'Bad tz', 'Mars/Olympus')$$, 'invalid_time_zone', 'bad time zone rejected');
select t.reset();

-- ---------- invites ----------
select t.as_user(t.id('owner'), 'owner@a.edu');
select t.lives($$insert into public.course_instructors (course_id, email, display_name, role) values (t.id('A'), ' Stranger@X.edu ', 'Stranger', 'observer')$$, 'owner invites by email');
select t.eq((select email from public.course_instructors where display_name = 'Stranger'), 'stranger@x.edu', 'invite email is normalised');
select t.reset();
select t.as_user(t.id('stranger'), 'stranger@x.edu');
select t.eq((select count(*)::text from public.courses), '0', 'before claiming, the invited user sees nothing');
select t.reset();
update auth.users set email_confirmed_at = null where id = t.id('stranger');
select t.as_user(t.id('stranger'), 'stranger@x.edu');
select t.eq(public.claim_instructor_invites() ->> 'claimed', '0', 'unconfirmed email claims nothing');
select t.reset();
update auth.users set email_confirmed_at = now() where id = t.id('stranger');
select t.as_user(t.id('stranger'), 'stranger@x.edu');
select t.eq(public.claim_instructor_invites() ->> 'claimed', '1', 'confirmed email claims the invite');
select t.eq(public.claim_instructor_invites() ->> 'claimed', '0', 'claiming twice claims nothing');
select t.eq((select count(*)::text from public.courses), '1', 'after claiming, the course is visible');
select t.is_true(public.has_perm(t.id('A'), 'view_results'), 'claimed observer can view results');
select t.reset();
select t.as_anon();
select t.throws('select public.claim_instructor_invites()', '42501', 'anon cannot claim');
select t.reset();

-- ---------- last coowner ----------
select t.as_user(t.id('owner'), 'owner@a.edu');
select t.throws($$delete from public.course_instructors where email = 'owner@a.edu'$$, 'last_coowner', 'cannot delete the last coowner');
select t.throws($$update public.course_instructors set role = 'manager' where email = 'owner@a.edu'$$, 'last_coowner', 'cannot demote the last coowner');
select t.lives($$update public.course_instructors set role = 'coowner' where email = 'mgr@a.edu'$$, 'coowner can promote a manager');
select t.lives($$update public.course_instructors set role = 'tutor' where email = 'owner@a.edu'$$, 'with another coowner, demotion works');
select t.reset();
select t.as_user(t.id('mgr'), 'mgr@a.edu');
select t.throws($$delete from public.course_instructors where email = 'mgr@a.edu'$$, 'last_coowner', 'the remaining coowner cannot be removed');
select t.lives($$delete from public.courses where id = t.id('A')$$, 'deleting a course works although it has a last coowner');
select t.eq((select count(*)::text from public.course_instructors where course_id = t.id('A')), '0', 'course delete cascaded to instructors');
select t.reset();

-- ---------- token regeneration (course B, untouched above) ----------
select t.as_user(t.id('bowner'), 'bowner@b.edu');
do $$
declare old text; new jsonb;
begin
  old := t.tok('Zed');
  new := public.regenerate_student_token(t.id('Zed'));
  perform t.is_true(new ->> 'access_token' <> old and length(new ->> 'access_token') >= 40, 'regenerated token differs and is long');
  perform t.reset();
  perform t.as_anon();
  perform t.throws(format('select public.student_portal(%L)', old), 'invalid_token', 'old token no longer works');
  perform t.lives(format('select public.student_portal(%L)', new ->> 'access_token'), 'new token works');
  perform t.reset();
end $$;
rollback;
