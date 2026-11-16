-- Writing answers: student_submit, instructor_submit, instructor_moderate, preview, leaks.
begin;
\ir seed.sql

create table t.s (k text primary key, v uuid);
grant select on t.s to public;

do $$
declare
  s uuid := t.mk_session('sub', interval '-1 day', interval '1 day');
  sc uuid := t.mk_session('sub-closed', interval '-2 days', interval '-1 day');
begin
  insert into t.s values ('s', s), ('sc', sc),
    ('q1', t.mk_q(s, 1, 'text', 'own_team_members')),
    ('q2', t.mk_q(s, 2, 'text', 'self', '{}', 'instructors')),
    ('q3', t.mk_q(s, 3, 'constsum_recipients', 'own_team_members', '{"points":100,"pointsPerOption":false,"distribute":"none"}')),
    ('qc', t.mk_q(sc, 1, 'text', 'own_team_members'));
end $$;

create function t.sub(p_who text, p_q text, p_answers jsonb) returns jsonb language sql as $$
  select public.student_submit(t.tok(p_who), (select v from t.s where k = 's'), (select v from t.s where k = p_q), p_answers) $$;

select t.as_anon();
select t.eq((t.sub('Alice', 'q1', jsonb_build_array(t.row(t.sk('Bob'), '{"text":"b1"}', 'note'), t.row(t.sk('Carol'), '{"text":"c1"}'))) ->> 'saved'), '2', 'student_submit saves two rows');
select t.eq((select count(*)::text from jsonb_array_elements(public.student_get_session(t.tok('Alice'), (select v from t.s where k = 's')) -> 'questions') q where q ->> 'number' = '1'), '1', 'get_session returns question 1');
select t.eq((select jsonb_array_length(q -> 'answers')::text from jsonb_array_elements(public.student_get_session(t.tok('Alice'), (select v from t.s where k = 's')) -> 'questions') q where q ->> 'number' = '1'), '2', 'get_session returns Alice''s two answers');
select t.eq((select jsonb_array_length(q -> 'recipients')::text from jsonb_array_elements(public.student_get_session(t.tok('Alice'), (select v from t.s where k = 's')) -> 'questions') q where q ->> 'number' = '1'), '2', 'get_session returns resolved recipients');
select t.eq((select string_agg(q ->> 'number', ',') from jsonb_array_elements(public.student_get_session(t.tok('Alice'), (select v from t.s where k = 's')) -> 'questions') q), '1,3', 'get_session lists only student-giver questions');
select t.is_true((select bool_and(q ? 'show_responses_to' and q ? 'show_giver_name_to' and q ? 'show_recipient_name_to') from jsonb_array_elements(public.student_get_session(t.tok('Alice'), (select v from t.s where k = 's')) -> 'questions') q), 'get_session includes the three visibility lists');
select t.eq((t.sub('Alice', 'q1', jsonb_build_array(t.row(t.sk('Bob'), '{"text":"b2"}'))) ->> 'saved'), '1', 'resubmitting replaces the giver''s rows');
select t.reset();
select t.eq((select count(*)::text from public.responses where question_id = (select v from t.s where k = 'q1')), '1', 'only one row remains after replace');
select t.eq((select answer ->> 'text' from public.responses where question_id = (select v from t.s where k = 'q1')), 'b2', 'the new answer is stored');
select t.eq((select updated_by from public.responses where question_id = (select v from t.s where k = 'q1')), 'student', 'updated_by = student');
select t.eq((select giver_key from public.responses where question_id = (select v from t.s where k = 'q1')), t.sk('Alice'), 'giver key comes from the token');

-- a bad batch leaves the old rows untouched
select t.as_anon();
select t.throws($$select public.student_submit(t.tok('Alice'), (select v from t.s where k = 's'), (select v from t.s where k = 'q1'),
  jsonb_build_array(t.row(t.sk('Bob'), '{"text":"ok"}'), t.row(t.sk('Carol'), '{"text":""}')))$$, 'empty_text', 'invalid answer is rejected');
select t.reset();
select t.eq((select answer ->> 'text' from public.responses where question_id = (select v from t.s where k = 'q1')), 'b2', 'rejected submit changed nothing');

select t.as_anon();
select t.throws($$select t.sub('Alice', 'q1', jsonb_build_array(t.row(t.sk('Dave'), '{"text":"x"}')))$$, 'not_a_recipient', 'recipient outside the resolved list');
select t.throws($$select t.sub('Alice', 'q1', jsonb_build_array(t.row(t.sk('Alice'), '{"text":"x"}')))$$, 'not_a_recipient', 'self not in own_team_members');
select t.throws($$select t.sub('Alice', 'q2', '[]')$$, 'not_a_giver', 'student cannot answer an instructor question');
select t.throws($$select t.sub('Alice', 'q3', jsonb_build_array(t.row(t.sk('Bob'), '{"points":50}'), t.row(t.sk('Carol'), '{"points":40}')))$$, 'sum_mismatch', 'constsum pool must add up');
select t.eq((t.sub('Alice', 'q3', jsonb_build_array(t.row(t.sk('Bob'), '{"points":50}'), t.row(t.sk('Carol'), '{"points":50}'))) ->> 'saved'), '2', 'constsum saved');
select t.throws(format('select public.student_submit(%L, %L, %L, ''[]'')', t.tok('Alice'), (select v from t.s where k = 'sc'), (select v from t.s where k = 'q1')), 'not_found', 'question from another session');
select t.throws(format('select public.student_submit(%L, %L, %L, ''[]'')', t.tok('Alice'), (select v from t.s where k = 'sc'), (select v from t.s where k = 'qc')), 'deadline_passed', 'closed session');
select t.throws(format('select public.student_submit(%L, %L, %L, ''[]'')', t.tok('Alice'), (select v from t.s where k = 's'), gen_random_uuid()), 'not_found', 'unknown question');
-- an empty array deletes
select t.eq((t.sub('Alice', 'q3', '[]') ->> 'saved'), '0', 'empty array saves nothing');
select t.reset();
select t.eq((select count(*)::text from public.responses where question_id = (select v from t.s where k = 'q3')), '0', 'empty array deletes the giver''s rows');

-- other students' answers and emails never appear in a student's session payload
select t.as_anon();
select t.sub('Bob', 'q1', jsonb_build_array(t.row(t.sk('Carol'), '{"text":"SECRET-BOB-TO-CAROL"}')));
select t.is_true(public.student_get_session(t.tok('Alice'), (select v from t.s where k = 's'))::text !~ 'SECRET-BOB-TO-CAROL', 'get_session hides other students'' answers');
select t.is_true(public.student_get_session(t.tok('Alice'), (select v from t.s where k = 's'))::text !~ '@s\.edu', 'get_session has no emails');
select t.is_true(public.student_portal(t.tok('Alice'))::text !~ '@s\.edu' or public.student_portal(t.tok('Alice'))::text ~ 'alice@s\.edu', 'portal shows at most the student''s own email');
select t.is_true(public.student_portal(t.tok('Alice'))::text !~ 'bob@s\.edu', 'portal has no other student''s email');
select t.reset();

-- ---------- instructors ----------
select t.as_user(t.id('tut'), 'tut@a.edu');
select t.eq((public.instructor_submit((select v from t.s where k = 's'), (select v from t.s where k = 'q2'),
   jsonb_build_array(t.row('i:' || (select id from public.course_instructors where email = 'tut@a.edu'), '{"text":"from tutor"}'))) ->> 'saved'), '1', 'tutor submits an instructor question');
select t.throws(format('select public.instructor_submit(%L, %L, ''[]'')', (select v from t.s where k = 's'), (select v from t.s where k = 'q1')), 'not_a_giver', 'instructor_submit on a student question');
select t.throws(format('select public.instructor_submit(%L, %L, %L)', (select v from t.s where k = 's'), (select v from t.s where k = 'q2'),
   jsonb_build_array(t.row(t.sk('Alice'), '{"text":"x"}'))), 'not_a_recipient', 'instructor_submit validates recipients');
select t.is_true(jsonb_array_length((public.instructor_get_submission((select v from t.s where k = 's')) -> 'questions') -> 0 -> 'answers') = 1, 'instructor_get_submission returns the saved answer');
select t.eq(jsonb_array_length(public.instructor_get_submission((select v from t.s where k = 's')) -> 'questions')::text, '1', 'instructor_get_submission lists only instructor-giver questions');
select t.reset();
select t.eq((select updated_by from public.responses where question_id = (select v from t.s where k = 'q2')), 'instructor', 'updated_by = instructor');
select t.as_user(t.id('tut'), 'tut@a.edu');
select t.throws(format('select public.instructor_submit(%L, %L, ''[]'')', (select v from t.s where k = 'sc'), (select v from t.s where k = 'qc')), 'not_a_giver', 'closed-session check order: giver first');
select t.reset();

-- moderation ignores the deadline and records the instructor
select t.as_user(t.id('mgr'), 'mgr@a.edu');
select t.eq((public.instructor_moderate((select v from t.s where k = 'sc'), (select v from t.s where k = 'qc'), t.id('Alice'),
   jsonb_build_array(t.row(t.sk('Bob'), '{"text":"moderated"}'))) ->> 'saved'), '1', 'moderate after the deadline');
select t.throws(format('select public.instructor_moderate(%L, %L, %L, %L)', (select v from t.s where k = 'sc'), (select v from t.s where k = 'qc'), t.id('Alice'),
   jsonb_build_array(t.row(t.sk('Dave'), '{"text":"x"}'))), 'not_a_recipient', 'moderate validates answers');
select t.throws(format('select public.instructor_moderate(%L, %L, %L, ''[]'')', (select v from t.s where k = 'sc'), (select v from t.s where k = 'qc'), t.id('Zed')), 'not_found', 'moderate: student of another course');
select t.throws(format('select public.instructor_moderate(%L, %L, %L, ''[]'')', (select v from t.s where k = 's'), (select v from t.s where k = 'q2'), t.id('Alice')), 'not_a_giver', 'moderate: instructor question');
select t.reset();
select t.eq((select updated_by from public.responses where question_id = (select v from t.s where k = 'qc')), 'mgr@a.edu', 'moderation sets updated_by to the instructor email');

-- preview equals the student's own view
select t.as_user(t.id('mgr'), 'mgr@a.edu');
select t.is_true(public.instructor_preview((select v from t.s where k = 's'), t.id('Alice')) = public.student_get_session(t.tok('Alice'), (select v from t.s where k = 's')),
                 'preview equals student_get_session');
select t.reset();
select t.as_user(t.id('mgr'), 'mgr@a.edu');
select t.lives(format('select public.instructor_preview(%L, %L)', t.mk_session('sub-future', interval '1 day', interval '2 days'), t.id('Alice')), 'preview works before the session opens');
select t.reset();

-- deleting a student removes the responses they gave and received
select t.eq((select count(*)::text from public.responses where giver_key = t.sk('Bob') or recipient_key = t.sk('Bob')), '3', 'Bob has responses given or received');
delete from public.students where id = t.id('Bob');
select t.eq((select count(*)::text from public.responses where giver_key = t.sk('Bob') or recipient_key = t.sk('Bob')), '0', 'deleting a student deletes their responses');
rollback;
