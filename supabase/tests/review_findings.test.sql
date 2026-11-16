-- Independent review (BUILD_NOTES/07-review.md). Each block PROVES a finding by asserting the behaviour
-- that exists TODAY. After a finding is fixed, the matching assertion must be inverted (the comment on
-- each block says how). Names start with "FINDING Fn:" so they are easy to grep in the run output.
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
-- Alice, an ordinary student, calls the public RPC with a hand-built body (the web form would send 100, not 100.0)
select t.eq((public.student_submit(t.tok('Alice'), (select v from t.rv where k = 'f1s'), (select v from t.rv where k = 'f1q'),
  jsonb_build_array(
    jsonb_build_object('recipient_key', t.sk('Alice'), 'answer', '{"value":100.0}'::jsonb),
    jsonb_build_object('recipient_key', t.sk('Bob'),   'answer', '{"value":100}'::jsonb),
    jsonb_build_object('recipient_key', t.sk('Carol'), 'answer', '{"value":100}'::jsonb))) ->> 'saved'),
  '3', 'FINDING F1: validate_answers accepts contrib value 100.0');
select t.throws(format('select public.student_get_results(%L, %L)', t.tok('Bob'), (select v from t.rv where k = 'f1s')),
  '22P02', 'FINDING F1: Bob''s entire results page now raises invalid input syntax for integer');
select t.throws(format('select public.student_get_results(%L, %L)', t.tok('Carol'), (select v from t.rv where k = 'f1s')),
  '22P02', 'FINDING F1: every teammate is locked out of results, all questions, not only the contrib one');
select t.lives(format('select public.student_get_results(%L, %L)', t.tok('Frank'), (select v from t.rv where k = 'f1s')),
  'F1 control: a student in another team is unaffected');
select t.reset();
select t.as_user(t.id('owner'), 'owner@a.edu');
select t.throws(format('select public.instructor_contrib_results(%L)', (select v from t.rv where k = 'f1q')),
  '22P02', 'FINDING F1: instructor CONTRIB results fail for the WHOLE course (loop over every team)');
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
do $$
declare tok text;
begin
  select access_token into tok from public.students where name = 'Alice';
  perform t.is_true(tok is not null and length(tok) >= 40, 'FINDING F2: an observer can SELECT Alice''s access_token');
  perform set_config('t.stolen', tok, true);
end $$;
select t.reset();
select t.as_anon();
select t.eq((public.student_submit(current_setting('t.stolen'), (select v from t.rv where k = 'f2s'), (select v from t.rv where k = 'f2q'),
  jsonb_build_array(t.row(t.sk('Bob'), '{"text":"written by an observer"}'))) ->> 'saved'),
  '1', 'FINDING F2: the observer''s copy of the token writes a response as Alice');
select t.reset();
select t.eq((select updated_by from public.responses where question_id = (select v from t.rv where k = 'f2q') and giver_key = t.sk('Alice')),
  'student', 'F2: the row is stored as a genuine student submission (updated_by = student), no trace of the observer');
select t.as_user(t.id('tut'), 'tut@a.edu');
select t.is_true((select count(*) from public.students where access_token is not null) = 10, 'FINDING F2: a tutor can read all 10 tokens too');
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
select t.eq(t.affected(format('update public.questions set show_giver_name_to = array[''recipient'',''instructors''] where id = %L', (select v from t.rv where k = 'f3q')))::text,
  '1', 'FINDING F3: a manager flips the giver-name list on a live, published question');
select t.reset();
select t.eq(t.rv_view('Bob', (select v from t.rv where k = 'f3s'), 1), 'Alice>Bob:A>B | Carol>Bob:C>B', 'FINDING F3: the promised anonymity is gone for already-submitted answers');

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
  s uuid := t.mk_session('rv-f4', interval '-1 day', interval '1 day', 15, 'at_open');
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
declare r jsonb; c jsonb; own int; others int[];
begin
  r := public.student_get_results(t.tok('Alice'), (select v from t.rv where k = 'f4s'));
  c := (r -> 'questions' -> 0 -> 'contrib' -> 'team_view_of_me');
  own := (c ->> 'own')::int;
  others := array(select e::int from jsonb_array_elements_text(c -> 'others') e order by 1 desc);
  perform t.is_true(own = 75 and others = array[125, 100],
    'FINDING F4: Alice sees team view own=75, others=[125,100] (got own=' || own || ' others=' || others::text || ')');
  -- Alice solves Carol's individual rating of Bob from her own claim of Bob (100): 2*125 - 100
  perform t.is_true(2 * others[1] - 100 = 150, 'FINDING F4: Carol''s individual rating of Bob (150) is recoverable by Alice');
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
select t.eq(t.rv_view('Dave', (select v from t.rv where k = 'f5s'), 1), 'Anonymous>Bob:my secret',
  'FINDING F8: giver is hidden but the recipient name (Bob) is shown, so Dave knows Bob wrote it');

-- ===========================================================================================
-- F9. No size limit on answer text or giver_comment (storage abuse by any token holder).
-- ===========================================================================================
select t.as_anon();
select t.eq((public.student_submit(t.tok('Alice'), (select v from t.rv where k = 'f2s'), (select v from t.rv where k = 'f2q'),
  jsonb_build_array(t.row(t.sk('Bob'), jsonb_build_object('text', repeat('x', 3000000)), repeat('y', 3000000)))) ->> 'saved'),
  '1', 'FINDING F9: a 3 MB answer and a 3 MB giver_comment are stored');
select t.reset();
select t.is_true((select pg_column_size(answer) + pg_column_size(giver_comment) from public.responses
                  where question_id = (select v from t.rv where k = 'f2q') and giver_key = t.sk('Alice')) > 0, 'F9: row stored');

-- ===========================================================================================
-- F9. Extra keys in answer objects are stored and returned unchanged (validate_answers never strips them).
-- ===========================================================================================
select t.as_anon();
select t.eq((public.student_submit(t.tok('Carol'), (select v from t.rv where k = 'f2s'), (select v from t.rv where k = 'f2q'),
  jsonb_build_array(t.row(t.sk('Bob'), '{"text":"ok","hidden":{"anything":[1,2,3]}}'))) ->> 'saved'),
  '1', 'FINDING F9: unknown keys in answer are accepted');
select t.reset();
select t.is_true((select answer ? 'hidden' from public.responses where question_id = (select v from t.rv where k = 'f2q') and giver_key = t.sk('Carol')),
  'F9: the unknown key is stored');

-- ===========================================================================================
-- F10. session_course(uuid) is executable by every signed-in user and answers for any session id.
-- ===========================================================================================
select t.as_user(t.id('stranger'), 'stranger@x.edu');
select t.eq(public.session_course((select v from t.rv where k = 'f1s'))::text, t.id('A')::text,
  'FINDING F10: an unrelated signed-in user can map a session id to its course id');
select t.reset();

rollback;
