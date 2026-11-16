-- Independent re-check of the fixes (BUILD_NOTES/07-review.md, "Re-check of fixes").
-- "FINDING R*" assertions assert behaviour that still exists after the fixes; invert them when fixed.
\set ON_ERROR_STOP on
begin;
\ir seed.sql

create table t.rr (k text primary key, v uuid);
grant select on t.rr to public;

create function t.rr_view(p_viewer text, p_session uuid, p_number int) returns text language plpgsql as $$
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

-- R1. F4 re-opened by editing: while results are visible and the session is open, Alice resubmits her own
-- contrib claims for a subset of teammates; her "team view of me" number changes with the subset, which
-- reveals the team average of Bob (hence Carol's rating of Bob).
do $$
declare
  s uuid := t.mk_session('rr-r1', interval '-1 day', interval '1 day', 15, 'at_open');
  q uuid := t.mk_q(s, 1, 'contrib', 'own_team_members_including_self', '{"isZeroSum":false,"isNotSureAllowed":false}',
                   'students', array['instructors','recipient','giver_team_members'], array['instructors'], array['instructors','recipient']);
begin
  insert into t.rr values ('r1s', s), ('r1q', q);
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  select s, q, t.sk(g), t.sk(r2), jsonb_build_object('value', v)
  from (values ('Alice','Alice',100),('Alice','Bob',100),('Alice','Carol',100),
               ('Bob','Alice',100),('Bob','Bob',100),('Bob','Carol',100),
               ('Carol','Alice',50),('Carol','Bob',150),('Carol','Carol',100)) x(g, r2, v);
end $$;
select t.as_anon();
do $$
declare s uuid := (select v from t.rr where k = 'r1s'); q uuid := (select v from t.rr where k = 'r1q');
        own_full numeric; own_part numeric; r jsonb;
begin
  r := public.student_get_results(t.tok('Alice'), s);
  own_full := (r -> 'questions' -> 0 -> 'contrib' -> 'team_view_of_me' ->> 'own')::numeric;
  -- Alice rates only herself (100) and Bob (200); no rating for Carol
  perform public.student_submit(t.tok('Alice'), s, q, jsonb_build_array(
    jsonb_build_object('recipient_key', t.sk('Alice'), 'answer', '{"value":100}'::jsonb),
    jsonb_build_object('recipient_key', t.sk('Bob'),   'answer', '{"value":200}'::jsonb)));
  r := public.student_get_results(t.tok('Alice'), s);
  own_part := (r -> 'questions' -> 0 -> 'contrib' -> 'team_view_of_me' ->> 'own')::numeric;
  raise notice 'own_full=% own_part=%', own_full, own_part;
  perform t.is_true(own_full is distinct from own_part, 'FINDING R1: Alice''s team-view number changes with which teammates she rates (full=' || own_full || ', partial=' || own_part || ')');
  -- avg_Alice = own_full (=75). own_part = avg_A * (100+200) / (avg_A + avg_B)  =>  avg_B = avg_A*300/own_part - avg_A
  perform t.is_true(abs(own_full * 300 / own_part - own_full - 125) <= 2, 'FINDING R1: Bob''s team average (125) is recoverable, so Carol''s rating of Bob is again 2*125-100 (within rounding)');
end $$;
select t.reset();

-- R2. Open item: moving a student between teams after answers exist changes who sees which giver names.
do $$
declare
  s uuid := t.mk_session('rr-r2', interval '-1 day', interval '1 day', 15, 'at_open');
  q uuid := t.mk_q(s, 1, 'text', 'own_team_members', '{}', 'students', array['giver_team_members','instructors'], array['giver_team_members','instructors'], '{}');
begin
  insert into t.rr values ('r2s', s);
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  values (s, q, t.sk('Alice'), t.sk('Bob'), '{"text":"A>B"}');
end $$;
select t.eq(t.rr_view('Dave', (select v from t.rr where k = 'r2s'), 1), 'ABSENT', 'R2 before: Dave (team T2) sees nothing');
select t.as_user(t.id('mgr'), 'mgr@a.edu');
select t.eq(t.affected(format('update public.students set team = ''T1'' where id = %L', t.id('Dave')))::text, '1', 'R2: manager moves Dave into T1 (also what a CSV re-import does)');
select t.reset();
select t.eq(t.rr_view('Dave', (select v from t.rr where k = 'r2s'), 1), 'Alice>Anonymous:A>B', 'FINDING R2: Dave now sees Alice''s earlier response with her name (giver-name list is giver_team_members)');

-- R3. Team rename: feedback addressed to team T1 follows the label, not the group of people.
do $$
declare
  s uuid := t.mk_session('rr-r3', interval '-1 day', interval '1 day', 15, 'at_open');
  q uuid := t.mk_q(s, 1, 'text', 'teams', '{}', 'students', array['recipient','instructors'], array['instructors'], array['recipient','instructors']);
begin
  insert into t.rr values ('r3s', s);
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  values (s, q, t.sk('Frank'), 't:S2|T3', '{"text":"for T3"}');
end $$;
select t.eq(t.rr_view('Gina', (select v from t.rr where k = 'r3s'), 1), 'ABSENT', 'R3 before: team T4 does not see feedback for T3');
select t.as_user(t.id('mgr'), 'mgr@a.edu');
select t.lives($$update public.students set team = 'T9' where name = 'Frank'$$, 'R3: rename T3 to T9');
select t.lives($$update public.students set team = 'T3' where team = 'T4' and section = 'S2'$$, 'R3: rename T4 to T3');
select t.reset();
select t.eq(t.rr_view('Gina', (select v from t.rr where k = 'r3s'), 1), 'Anonymous>T3:for T3', 'FINDING R3: team T4 (now labelled T3) reads feedback written for the old T3');

-- R4. visibility_locked: removing is allowed, adding is not; renumbering is allowed
do $$
declare
  s uuid := t.mk_session('rr-r4', interval '-1 day', interval '1 day');
  q uuid := t.mk_q(s, 1, 'text', 'own_team_members', '{}', 'students', array['recipient','instructors'], array['instructors'], array['recipient','instructors']);
begin
  insert into t.rr values ('r4q', q);
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer) values (s, q, t.sk('Alice'), t.sk('Bob'), '{"text":"x"}');
end $$;
select t.as_user(t.id('mgr'), 'mgr@a.edu');
select t.throws(format('update public.questions set show_responses_to = array[''recipient'',''instructors'',''students''] where id = %L', (select v from t.rr where k = 'r4q')), 'visibility_locked', 'R4: adding students is blocked');
select t.throws(format('update public.questions set show_responses_to = array[''recipient'',''instructors'',''giver_team_members''], show_giver_name_to = array[''instructors'', ''giver_team_members''] where id = %L', (select v from t.rr where k = 'r4q')), 'visibility_locked', 'R4: adding giver_team_members blocked');
select t.lives(format('update public.questions set number = 7 where id = %L', (select v from t.rr where k = 'r4q')), 'R4: renumbering allowed');
select t.lives(format('update public.questions set show_giver_name_to = ''{}'' where id = %L', (select v from t.rr where k = 'r4q')), 'R4: narrowing allowed');
-- re-adding what was removed is also blocked (no remove-then-add loophole across calls)
select t.throws(format('update public.questions set show_giver_name_to = array[''instructors''] where id = %L', (select v from t.rr where k = 'r4q')), 'visibility_locked', 'R4: re-adding a removed entry is blocked');
select t.reset();

-- R5. students column grants
select t.as_user(t.id('mgr'), 'mgr@a.edu');
select t.throws('select access_token from public.students', '42501', 'R5: manager cannot select access_token');
select t.throws('select * from public.students', '42501', 'R5: select * is refused');
select t.lives('select id, name, email, team from public.students', 'R5: named columns work');
select t.eq(t.affected($$update public.students set comments = 'c' where name = 'Bob'$$)::text, '1', 'R5: update works');
select t.eq(t.affected($$delete from public.students where name = 'Jon'$$)::text, '1', 'R5: delete with returning-free path works');
select t.is_true(jsonb_array_length(public.instructor_student_links(t.id('A'))) >= 9, 'R5: manager gets links');
select t.reset();
rollback;
