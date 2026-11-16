-- Independent review (BUILD_NOTES/07-review.md). Each block first proved a finding; after the fixes
-- (BUILD_NOTES/08-review-fixes.md) every assertion is inverted and proves the fix. Names start with
-- "FIXED Fn:" so they are easy to grep in the run output.
\set ON_ERROR_STOP on
begin;
\ir seed.sql

create table t.rv (k text primary key, v uuid);
grant select on t.rv to public;

-- one text-ish helper: giver>recipient:text rows as one viewer sees them
create function t.rv_view(p_viewer text, p_session uuid, p_number int) returns text language plpgsql as $$
declare r jsonb; q jsonb; out text;
begin
  perform t.as_anon();
  r := public.student_get_results(t.tok(p_viewer), p_session);
  perform t.reset();
  select e into q from jsonb_array_elements(r -> 'questions') e where (e ->> 'number')::int = p_number;
  if q is null then return 'ABSENT'; end if;
  select string_agg((x ->> 'giver_name') || '>' || (x ->> 'recipient_name') || ':' || (x -> 'answer' ->> 'text'), ' | '
                    order by (x ->> 'giver_name') || '>' || (x ->> 'recipient_name') || ':' || (x -> 'answer' ->> 'text'))
    into out from jsonb_array_elements(q -> 'responses') x;
  return coalesce(out, 'EMPTY');
end $$;

-- ===========================================================================================
-- F1. A student can poison results for a whole team and the instructor CONTRIB page of the whole course.
-- validate_answers accepts {"value":100.0} (jb_is_int is true for 100.0); contrib_team_result then runs
-- (answer ->> 'value')::int on the stored text "100.0" and raises 22P02.
-- After the fix: submit must still succeed (or reject) and the two calls below must NOT raise.
-- ===========================================================================================
do $$
declare
  s uuid := t.mk_session('rv-f1', interval '-1 day', interval '1 day', 15, 'at_open');
  q uuid;
  r jsonb;
begin
  q := t.mk_q(s, 1, 'contrib', 'own_team_members_including_self', '{"isZeroSum":false,"isNotSureAllowed":false}',
              'students', array['instructors','recipient','giver_team_members'], array['instructors'], array['instructors','recipient']);
  insert into t.rv values ('f1s', s), ('f1q', q);
  -- honest answers from Bob and Carol
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  select s, q, t.sk(g), t.sk(r2), jsonb_build_object('value', v)
  from (values ('Bob','Alice',100),('Bob','Bob',100),('Bob','Carol',100),
               ('Carol','Alice',100),('Carol','Bob',100),('Carol','Carol',100)) x(g, r2, v);
  -- Dave (team T2) answers normally; he must not be affected
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  select s, q, t.sk('Dave'), t.sk(r2), jsonb_build_object('value', 100) from (values ('Dave'),('Erin')) x(r2);
end $$;

select t.as_anon();
-- Alice calls the public RPC with a hand-built body (the web form would send 100, not 100.0)
select t.throws(format('select public.student_submit(%L, %L, %L, %L::jsonb)', t.tok('Alice'), (select v from t.rv where k = 'f1s'), (select v from t.rv where k = 'f1q'),
  jsonb_build_array(
    jsonb_build_object('recipient_key', t.sk('Alice'), 'answer', '{"value":100.0}'::jsonb),
    jsonb_build_object('recipient_key', t.sk('Bob'),   'answer', '{"value":100}'::jsonb),
    jsonb_build_object('recipient_key', t.sk('Carol'), 'answer', '{"value":100}'::jsonb))),
  'invalid_answer', 'FIXED F1: contrib value 100.0 is rejected');
select t.throws(format('select public.student_submit(%L, %L, %L, %L::jsonb)', t.tok('Alice'), (select v from t.rv where k = 'f1s'), (select v from t.rv where k = 'f1q'),
  jsonb_build_array(jsonb_build_object('recipient_key', t.sk('Bob'), 'answer', '{"value":100.5}'::jsonb))),
  'invalid_answer', 'FIXED F1: contrib value 100.5 is rejected');
select t.eq((public.student_submit(t.tok('Alice'), (select v from t.rv where k = 'f1s'), (select v from t.rv where k = 'f1q'),
  jsonb_build_array(
    jsonb_build_object('recipient_key', t.sk('Alice'), 'answer', '{"value":1e2}'::jsonb),
    jsonb_build_object('recipient_key', t.sk('Bob'),   'answer', '{"value":100}'::jsonb))) ->> 'saved'),
  '2', 'FIXED F1: 1e2 is the integer 100 once parsed and is stored as 100');
select t.reset();
select t.eq((select answer::text from public.responses where question_id = (select v from t.rv where k = 'f1q') and giver_key = t.sk('Alice') and recipient_key = t.sk('Alice')),
  '{"value": 100}', 'FIXED F1: the stored form is canonical');

-- A bad row that is already stored (inserted directly as postgres, as an old version could have) must not
-- break anything: a non-integral number is rounded, a non-number counts as not submitted.
insert into public.responses (session_id, question_id, giver_key, recipient_key, answer) values
  ((select v from t.rv where k = 'f1s'), (select v from t.rv where k = 'f1q'), t.sk('Alice'), t.sk('Bob'),   '{"value":100.0}'),
  ((select v from t.rv where k = 'f1s'), (select v from t.rv where k = 'f1q'), t.sk('Alice'), t.sk('Carol'), '{"value":"abc"}'),
  ((select v from t.rv where k = 'f1s'), (select v from t.rv where k = 'f1q'), t.sk('Dave'),  t.sk('Dave'),  '{"value":1e400}')
  on conflict do nothing;
select t.as_anon();
select t.lives(format('select public.student_get_results(%L, %L)', t.tok('Bob'), (select v from t.rv where k = 'f1s')),
  'FIXED F1: a stored 100.0 and a stored "abc" do not break Bob''s results');
select t.lives(format('select public.student_get_results(%L, %L)', t.tok('Alice'), (select v from t.rv where k = 'f1s')),
  'FIXED F1: nor Alice''s results');
select t.lives(format('select public.student_get_results(%L, %L)', t.tok('Dave'), (select v from t.rv where k = 'f1s')),
  'FIXED F1: nor the results of a team holding an out-of-range number');
select t.reset();
select t.as_user(t.id('owner'), 'owner@a.edu');
select t.lives(format('select public.instructor_contrib_results(%L)', (select v from t.rv where k = 'f1q')),
  'FIXED F1: instructor CONTRIB results still work for the whole course');
select t.reset();

-- ===========================================================================================
-- F2. Any instructor row, including observer and tutor, can read students.access_token and then act as the
-- student through the anon RPCs (read results as that student, overwrite that student's ratings).
-- After the fix: the select of access_token must raise 42501 for observer and tutor.
-- ===========================================================================================
do $$
declare
  s uuid := t.mk_session('rv-f2', interval '-1 day', interval '1 day');
  q uuid := t.mk_q(s, 1, 'text', 'own_team_members', '{}', 'students', array['recipient','instructors'], array['instructors'], array['recipient','instructors']);
begin
  insert into t.rv values ('f2s', s), ('f2q', q);
end $$;

select t.as_user(t.id('obs'), 'obs@a.edu');
select t.throws($q$select access_token from public.students where name = 'Alice'$q$, '42501', 'FIXED F2: an observer cannot SELECT access_token');
select t.throws($q$select * from public.students$q$, '42501', 'FIXED F2: select * on students is refused too');
select t.is_true((select count(*) from public.students) = 10, 'F2: the other student columns remain readable');
select t.throws(format('select public.instructor_student_links(%L)', t.id('A')), 'forbidden', 'FIXED F2: the links RPC refuses an observer');
select t.reset();
select t.as_user(t.id('tut'), 'tut@a.edu');
select t.throws($q$select access_token from public.students$q$, '42501', 'FIXED F2: a tutor cannot read tokens either');
select t.throws(format('select public.instructor_student_links(%L)', t.id('A')), 'forbidden', 'FIXED F2: the links RPC refuses a tutor');
select t.reset();
select t.as_user(t.id('mgr'), 'mgr@a.edu');
select t.is_true((select jsonb_array_length(public.instructor_student_links(t.id('A'))) = 10
                  and (public.instructor_student_links(t.id('A')) -> 0 ->> 'token') = t.tok_of_email(public.instructor_student_links(t.id('A')) -> 0 ->> 'email')
                  and (public.instructor_student_links(t.id('A')) -> 0) ?& array['student_id','section','team','name','email','token']),
  'F2: a manager (modify_students) gets all 10 links with the six keys');
select t.reset();
select t.as_user(t.id('bowner'), 'bowner@b.edu');
select t.throws(format('select public.instructor_student_links(%L)', t.id('A')), 'forbidden', 'F2: the owner of another course gets nothing');
select t.reset();

-- ===========================================================================================
-- F3. An instructor can switch a question's visibility lists AFTER students answered, which retroactively
-- shows hidden giver names to every student (no lock once responses exist or results are published).
-- After the fix: the update must be rejected (or affect 0 rows) once the question has responses.
-- ===========================================================================================
do $$
declare
  s uuid := t.mk_session('rv-f3', interval '-1 day', interval '1 day', 15, 'at_open');
  q uuid := t.mk_q(s, 1, 'text', 'own_team_members', '{}', 'students', array['recipient','instructors'], array['instructors'], array['recipient','instructors']);
begin
  insert into t.rv values ('f3s', s), ('f3q', q);
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer) values
    (s, q, t.sk('Alice'), t.sk('Bob'), '{"text":"A>B"}'), (s, q, t.sk('Carol'), t.sk('Bob'), '{"text":"C>B"}');
end $$;
select t.eq(t.rv_view('Bob', (select v from t.rv where k = 'f3s'), 1), 'Anonymous>Bob:A>B | Anonymous>Bob:C>B', 'F3 before: Bob sees anonymous givers');
select t.as_user(t.id('mgr'), 'mgr@a.edu');
select t.throws(format('update public.questions set show_giver_name_to = array[''recipient'',''instructors''] where id = %L', (select v from t.rv where k = 'f3q')),
  'visibility_locked', 'FIXED F3: adding an entry to the giver-name list is rejected once there are responses');
select t.throws(format('update public.questions set show_responses_to = array[''recipient'',''instructors'',''students''] where id = %L', (select v from t.rv where k = 'f3q')),
  'visibility_locked', 'FIXED F3: so is adding to the responses list');
select t.eq(t.affected(format('update public.questions set show_recipient_name_to = array[''recipient''] where id = %L', (select v from t.rv where k = 'f3q')))::text,
  '1', 'F3: removing an entry stays allowed');
select t.eq(t.affected(format('update public.questions set brief = ''renamed'' where id = %L', (select v from t.rv where k = 'f3q')))::text,
  '1', 'F3: other edits stay allowed');
select t.reset();
select t.eq(t.rv_view('Bob', (select v from t.rv where k = 'f3s'), 1), 'Anonymous>Bob:A>B | Anonymous>Bob:C>B', 'FIXED F3: the promised anonymity holds for already-submitted answers');
-- a question without responses may still be changed, and a change of type that deletes the responses is not blocked
do $$
declare q2 uuid := t.mk_q((select v from t.rv where k = 'f3s'), 2, 'text', 'own_team_members', '{}', 'students', array['recipient','instructors'], array['instructors'], array['recipient','instructors']);
begin
  perform t.is_true(t.affected(format('update public.questions set show_giver_name_to = array[''recipient'',''instructors''] where id = %L', q2)) = 1, 'F3: a question with no responses can still change visibility');
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
    values ((select v from t.rv where k = 'f3s'), q2, t.sk('Alice'), t.sk('Bob'), '{"text":"x"}');
  perform t.is_true(t.affected(format('update public.questions set type = ''numscale'', details = %L::jsonb, show_responses_to = array[''recipient'',''instructors'',''students''], show_giver_name_to = array[''recipient'',''instructors'',''students''] where id = %L',
    '{"min":1,"max":5,"step":1}', q2)) = 1, 'F3: a type change deletes the responses first, so the visibility change goes through');
end $$;
do $$
declare q3 uuid := t.mk_q((select v from t.rv where k = 'f3s'), 3, 'text', 'own_team_members', '{}', 'students', array['recipient','instructors'], array['instructors'], array['instructors']);
begin
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
    values ((select v from t.rv where k = 'f3s'), q3, t.sk('Alice'), t.sk('Bob'), '{"text":"x"}');
  perform t.throws(format('update public.questions set show_recipient_name_to = array[''recipient'',''instructors''] where id = %L', q3),
    'visibility_locked', 'FIXED F3: adding to the recipient-name list is rejected too');
end $$;

-- ===========================================================================================
-- F4. CONTRIB: in a 3-person team the "team view" numbers returned to a student let her solve the exact
-- rating one teammate gave another (and the ones given to her). Not a raw leak, but arithmetic on aggregates.
-- Team T1: Alice, Bob, Carol. Carol rates Alice 50 and Bob 150; everyone else rates 100.
-- avg perceived: Alice 75, Bob 125, Carol 100. Alice sees own 75 and others [125, 100].
-- 125 = (Alice->Bob 100 + Carol->Bob x) / 2  =>  x = 150, Carol's individual rating of Bob.
-- After the fix (hide `others` of team_view_of_me, or require team size >= 4): this assertion changes.
-- ===========================================================================================
do $$
declare
  s uuid := t.mk_session('rv-f4', interval '-2 days', interval '-1 hour', 15, 'at_open');
  q uuid := t.mk_q(s, 1, 'contrib', 'own_team_members_including_self', '{"isZeroSum":false,"isNotSureAllowed":false}',
                   'students', array['instructors','recipient','giver_team_members'], array['instructors'], array['instructors','recipient']);
begin
  insert into t.rv values ('f4s', s), ('f4q', q);
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  select s, q, t.sk(g), t.sk(r2), jsonb_build_object('value', v)
  from (values ('Alice','Alice',100),('Alice','Bob',100),('Alice','Carol',100),
               ('Bob','Alice',100),('Bob','Bob',100),('Bob','Carol',100),
               ('Carol','Alice',50),('Carol','Bob',150),('Carol','Carol',100)) x(g, r2, v);
end $$;
select t.as_anon();
do $$
declare r jsonb; c jsonb;
begin
  r := public.student_get_results(t.tok('Alice'), (select v from t.rv where k = 'f4s'));
  c := (r -> 'questions' -> 0 -> 'contrib');
  perform t.is_true(not ((c -> 'team_view_of_me') ? 'others'), 'FIXED F4: team_view_of_me has no list of the teammates');
  perform t.eq(c #>> '{team_view_of_me,own}', '75', 'F4: the team view of Alice herself is kept');
  perform t.eq(c #>> '{my_claim,own}', '100', 'F4: her own claim is kept');
  perform t.eq(c #>> '{my_claim,others}', '[100, 100]', 'F4: her own ratings of others are kept');
  perform t.is_true(c::text !~ '125', 'F4: Bob''s 125 appears nowhere');
end $$;
select t.reset();

-- ===========================================================================================
-- F8. Self-referencing recipients defeat "hidden giver": with recipient_type self (or a self row inside a team
-- list) and recipient names visible, the recipient name IS the giver name.
-- ===========================================================================================
do $$
declare
  s uuid := t.mk_session('rv-f5', interval '-1 day', interval '1 day', 15, 'at_open');
  q uuid := t.mk_q(s, 1, 'text', 'self', '{}', 'students', array['students'], '{}', array['students']);
begin
  insert into t.rv values ('f5s', s);
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  values (s, q, t.sk('Bob'), t.sk('Bob'), '{"text":"my secret"}');
end $$;
select t.eq(t.rv_view('Dave', (select v from t.rv where k = 'f5s'), 1), 'Anonymous>Anonymous:my secret',
  'FIXED F8: giver hidden and recipient is the giver, so the recipient name is hidden too');
select t.eq(t.rv_view('Bob', (select v from t.rv where k = 'f5s'), 1), 'Bob>Bob:my secret', 'F8: Bob sees his own row in full');
select t.is_true((select sees_giver_name = false and sees_recipient_name = false from public.can_view(
  (select id from public.questions where session_id = (select v from t.rv where k = 'f5s')),
  (select id from public.responses where session_id = (select v from t.rv where k = 'f5s')), t.id('Dave'))), 'F8: can_view says the same');
-- giver visible: recipient name follows its own list
create temp table f8r on commit drop as select * from public.responses where session_id = (select v from t.rv where k = 'f5s');
delete from public.responses where session_id = (select v from t.rv where k = 'f5s');
update public.questions set show_giver_name_to = array['students'] where session_id = (select v from t.rv where k = 'f5s');
insert into public.responses select * from f8r;
select t.eq(t.rv_view('Dave', (select v from t.rv where k = 'f5s'), 1), 'Bob>Bob:my secret', 'F8: when the giver name is visible the recipient name is shown as listed');

-- ===========================================================================================
-- F9. Size limits and unknown keys.
-- ===========================================================================================
select t.as_anon();
select t.throws(format('select public.student_submit(%L, %L, %L, %L::jsonb)', t.tok('Alice'), (select v from t.rv where k = 'f2s'), (select v from t.rv where k = 'f2q'),
  jsonb_build_array(t.row(t.sk('Bob'), jsonb_build_object('text', repeat('x', 10001))))), 'too_long', 'FIXED F9: a text answer over 10000 characters is rejected');
select t.throws(format('select public.student_submit(%L, %L, %L, %L::jsonb)', t.tok('Alice'), (select v from t.rv where k = 'f2s'), (select v from t.rv where k = 'f2q'),
  jsonb_build_array(t.row(t.sk('Bob'), '{"text":"ok"}'::jsonb, repeat('y', 2001)))), 'too_long', 'FIXED F9: a giver_comment over 2000 characters is rejected');
select t.eq((public.student_submit(t.tok('Alice'), (select v from t.rv where k = 'f2s'), (select v from t.rv where k = 'f2q'),
  jsonb_build_array(t.row(t.sk('Bob'), jsonb_build_object('text', repeat('x', 10000)), repeat('y', 2000)))) ->> 'saved'),
  '1', 'F9: exactly 10000 and 2000 characters are accepted');
select t.reset();
select t.eq((select (length(answer ->> 'text') || '/' || length(giver_comment)) from public.responses
             where question_id = (select v from t.rv where k = 'f2q') and giver_key = t.sk('Alice')), '10000/2000', 'F9: stored at the limit');

select t.as_anon();
select t.eq((public.student_submit(t.tok('Carol'), (select v from t.rv where k = 'f2s'), (select v from t.rv where k = 'f2q'),
  jsonb_build_array(t.row(t.sk('Bob'), '{"text":"ok","hidden":{"anything":[1,2,3]}}'))) ->> 'saved'),
  '1', 'F9: an answer with an unknown key is accepted');
select t.reset();
select t.eq((select answer::text from public.responses where question_id = (select v from t.rv where k = 'f2q') and giver_key = t.sk('Carol')),
  '{"text": "ok"}', 'FIXED F9: the unknown key is not stored');

-- ===========================================================================================
-- F10. session_course(uuid) answers only for members of the session's course.
-- ===========================================================================================
select t.as_user(t.id('stranger'), 'stranger@x.edu');
select t.is_true(public.session_course((select v from t.rv where k = 'f1s')) is null,
  'FIXED F10: an unrelated signed-in user gets nothing for a session id');
select t.reset();
select t.as_user(t.id('obs'), 'obs@a.edu');
select t.eq(public.session_course((select v from t.rv where k = 'f1s'))::text, t.id('A')::text, 'F10: a member of the course still gets the course id');
select t.reset();

rollback;
