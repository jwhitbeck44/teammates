-- Second review fixes (BUILD_NOTES/09-second-review-fixes.md), migration 20261117000013.
--   Item 2: contribution results come from the teams stored on the response rows.
--   Item 3: student pages get shown_deadline (close time or extension, no grace).
--   Item 4: the portal counts questions answered out of questions the student can answer.
--   Item 6: copy_session gives the copy the new-session default times.
\set ON_ERROR_STOP on
begin;
\ir seed.sql

create table t.sr (k text primary key, v uuid);
create table t.snap (k text primary key, v jsonb);
grant select, insert on t.sr, t.snap to public;
create function t.sr(p text) returns uuid language sql stable as $$ select v from t.sr where k = p $$;
-- contrib rows of one question as postgres (the session is closed, so the RPC would refuse); the trigger stamps teams
create function t.contrib_rows(p_q uuid, p_rows jsonb) returns void language sql as $$
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer)
  select (select session_id from public.questions where id = p_q), p_q, t.sk(x ->> 0), t.sk(x ->> 1),
         jsonb_build_object('value', (x ->> 2)::int)
  from jsonb_array_elements(p_rows) x $$;
-- the instructor table rows of one team, without ids and emails
create function t.contrib_team(p_q uuid, p_team text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform t.as_user(t.id('owner'), 'owner@a.edu');
  select coalesce(jsonb_agg(e - 'student_id' - 'email' order by e ->> 'name'), '[]') into r
  from jsonb_array_elements(public.instructor_contrib_results(p_q) -> 'students') e where e ->> 'team' = p_team;
  perform t.reset();
  return r;
end $$;
create function t.cc_pc(p_q uuid, p_team text) returns text language sql as $$
  select string_agg((e ->> 'name') || ' ' || (e ->> 'claimed') || '/' || (e ->> 'perceived'), ', ' order by e ->> 'name')
  from jsonb_array_elements(t.contrib_team(p_q, p_team)) e $$;

-- ---------------------------------------------------------------------------
-- Item 2. The review's case: S1/T1 = Alice, Bob, Carol, zero-sum, closed session.
-- ---------------------------------------------------------------------------
insert into t.sr values ('s', t.mk_session('contrib closed', interval '-3 days', interval '-2 days'));
update public.sessions set published_at = now() - interval '1 day' where id = t.sr('s');
insert into t.sr values ('q', t.mk_q(t.sr('s'), 1, 'contrib', 'own_team_members_including_self',
  '{"isZeroSum":true,"isNotSureAllowed":false}', 'students',
  '{recipient,giver_team_members,instructors}', '{instructors}', '{recipient,instructors}'));
select t.contrib_rows(t.sr('q'), '[["Alice","Alice",100],["Alice","Bob",120],["Alice","Carol",80],
                                  ["Bob","Alice",110],["Bob","Bob",100],["Bob","Carol",90],
                                  ["Carol","Alice",120],["Carol","Bob",110],["Carol","Carol",70]]');

select t.eq(t.cc_pc(t.sr('q'), 'T1'), 'Alice 100/107, Bob 100/108, Carol 70/85', 'T1 before the move: the review''s numbers');
insert into t.snap values ('t1_before', t.contrib_team(t.sr('q'), 'T1'));

-- the move the review made
update public.students set team = 'T2' where id = t.id('Carol');
update public.students set team = 'T1' where id = t.id('Dave');

select t.eq(t.cc_pc(t.sr('q'), 'T1'), 'Alice 100/107, Bob 100/108, Carol 70/85', 'FIXED item 2: T1 after the move has the same numbers');
select t.eq(t.contrib_team(t.sr('q'), 'T1')::text, (select v::text from t.snap where k = 't1_before'), 'FIXED item 2: the whole T1 block (ratings received, diff) is unchanged');
select t.eq((select string_agg(e ->> 'name', ',' order by e ->> 'name') from jsonb_array_elements(t.contrib_team(t.sr('q'), 'T2')) e),
  'Erin', 'T2 has no responses: current roster, without Carol (rated in T1) and without Dave (moved out)');
select t.eq((select count(*)::text from jsonb_array_elements(t.contrib_team(t.sr('q'), 'T1')) e where e ->> 'name' = 'Dave'), '0',
  'Dave joined T1 after every T1 answer was saved: not added to T1');
select t.eq((select string_agg(team_key, ',') from public.contrib_team_members(t.sr('q')) where student_id = t.id('Carol')), 't:S1|T1',
  'contrib_team_members puts Carol in the team she was rated in');
select t.eq((select count(*)::text from public.contrib_team_members(t.sr('q')) where student_id = t.id('Dave')), '0',
  'contrib_team_members leaves Dave out (no stored record, current team has stored rows)');
select t.eq((select string_agg(e ->> 'name', ',' order by e ->> 'name') from jsonb_array_elements(t.contrib_team(t.sr('q'), 'T4')) e),
  'Gina,Hal,Ivy,Jon', 'a team with no responses uses the current roster');
select t.eq((select string_agg(distinct e ->> 'perceived', ',') from jsonb_array_elements(t.contrib_team(t.sr('q'), 'T4')) e),
  '-9999', 'a team with no responses: perceived is N/A for everyone');

-- the moved student's own view uses the old team
select t.as_anon();
select t.eq((select q -> 'contrib' ->> 'team_view_of_me' from jsonb_array_elements(public.student_get_results(t.tok('Carol'), t.sr('s')) -> 'questions') q
             where q ->> 'type' = 'contrib'), '{"own": 85}', 'FIXED item 2: Carol, moved to T2, still sees the team view from T1');
select t.eq((select q -> 'contrib' ->> 'my_claim' from jsonb_array_elements(public.student_get_results(t.tok('Carol'), t.sr('s')) -> 'questions') q
             where q ->> 'type' = 'contrib'), '{"own": 70, "others": [120, 110]}', 'Carol''s own claim is unchanged');
select t.eq((select q -> 'contrib' ->> 'team_view_of_me' from jsonb_array_elements(public.student_get_results(t.tok('Alice'), t.sr('s')) -> 'questions') q
             where q ->> 'type' = 'contrib'), '{"own": 107}', 'Alice''s team view is unchanged');
select t.eq((select count(*)::text from jsonb_array_elements(public.student_get_results(t.tok('Dave'), t.sr('s')) -> 'questions') q
             where q ->> 'type' = 'contrib'), '0', 'Dave (moved into T1 later) gets no contribution summary');
select t.reset();

-- a deleted student: students_cleanup deletes the rows they gave and received; the rest of the team is recomputed
delete from public.students where id = t.id('Bob');
select t.eq((select string_agg(e ->> 'name', ',' order by e ->> 'name') from jsonb_array_elements(t.contrib_team(t.sr('q'), 'T1')) e),
  'Alice,Carol', 'a deleted student is left out of the team');
select t.eq((select (public.contrib_team_result(t.sr('q'), 't:S1|T1') -> 'claimed')::text), '[[100, 80], [120, 70]]',
  'the matrix of the remaining members holds their stored ratings of each other');

-- ---------------------------------------------------------------------------
-- Item 2. Two givers of one team with different stored member lists: Kim joins T4 after Gina answered.
-- ---------------------------------------------------------------------------
insert into t.sr values ('s2', t.mk_session('contrib grow', interval '-3 days', interval '-2 days'));
insert into t.sr values ('q2', t.mk_q(t.sr('s2'), 1, 'contrib', 'own_team_members_including_self',
  '{"isZeroSum":false,"isNotSureAllowed":false}', 'students',
  '{recipient,giver_team_members,instructors}', '{instructors}', '{recipient,instructors}'));
select t.contrib_rows(t.sr('q2'), '[["Gina","Gina",100],["Gina","Hal",100],["Gina","Ivy",100],["Gina","Jon",100]]');
insert into public.students (course_id, section, team, name, email) values (t.id('A'), 'S2', 'T4', 'Kim', 'kim@s.edu');
insert into t.ids select 'Kim', id from public.students where email = 'kim@s.edu';
select t.contrib_rows(t.sr('q2'), '[["Hal","Gina",100],["Hal","Hal",100],["Hal","Ivy",100],["Hal","Jon",100],["Hal","Kim",100]]');
select t.eq((select string_agg(array_length(giver_team_ids, 1)::text, ',' order by array_length(giver_team_ids, 1)) from
             (select distinct giver_key, giver_team_ids from public.responses where question_id = t.sr('q2')) x), '4,5',
  'the two givers have different stored member lists');
select t.eq((select string_agg(e ->> 'name', ',' order by e ->> 'name') from jsonb_array_elements(t.contrib_team(t.sr('q2'), 'T4')) e),
  'Gina,Hal,Ivy,Jon,Kim', 'the team is everyone either list names');
select t.eq((select (public.contrib_team_result(t.sr('q2'), 't:S2|T4') -> 'claimed' -> 0)::text), '[100, 100, 100, 100, -999]',
  'Gina did not rate Kim: not submitted (-999)');

-- ---------------------------------------------------------------------------
-- Item 3. shown_deadline: close time, or the extension; deadline stays the real cutoff.
-- ---------------------------------------------------------------------------
insert into t.sr values ('s3', t.mk_session('open now', interval '-1 day', interval '1 day', 15));
insert into public.deadline_extensions (session_id, student_id, closes_at)
select t.sr('s3'), t.id('Erin'), closes_at + interval '2 days' from public.sessions where id = t.sr('s3');
insert into public.deadline_extensions (session_id, student_id, closes_at)
select t.sr('s3'), t.id('Carol'), closes_at + interval '5 minutes' from public.sessions where id = t.sr('s3');
-- close time of a session, readable while acting as anon
create function t.closes(p_session uuid) returns timestamptz language sql stable security definer as
  $$ select closes_at from public.sessions where id = p_session $$;
create function t.portal_session(p_student text, p_session uuid) returns jsonb language sql as $$
  select e from jsonb_array_elements(public.student_portal(t.tok(p_student)) -> 'sessions') e where (e ->> 'id')::uuid = p_session $$;

select t.as_anon();
select t.is_true((select (t.portal_session('Alice', t.sr('s3')) ->> 'shown_deadline')::timestamptz = t.closes(t.sr('s3'))),
  'FIXED item 3: portal shown_deadline is the close time');
select t.is_true((select (t.portal_session('Alice', t.sr('s3')) ->> 'deadline')::timestamptz = t.closes(t.sr('s3')) + interval '15 minutes'),
  'portal deadline is still close time plus grace (the real cutoff)');
select t.is_true((select (t.portal_session('Erin', t.sr('s3')) ->> 'shown_deadline')::timestamptz = t.closes(t.sr('s3')) + interval '2 days'),
  'with an extension: shown_deadline is the extension');
select t.is_true((select (t.portal_session('Carol', t.sr('s3')) ->> 'shown_deadline')::timestamptz = t.closes(t.sr('s3')) + interval '5 minutes'
                     and (t.portal_session('Carol', t.sr('s3')) ->> 'deadline')::timestamptz = t.closes(t.sr('s3')) + interval '15 minutes'
  ),
  'an extension shorter than the grace period: shown is the extension, the cutoff stays close plus grace');
select t.is_true((select (public.student_get_session(t.tok('Alice'), t.sr('s3')) -> 'session' ->> 'shown_deadline')::timestamptz = t.closes(t.sr('s3'))
  ), 'FIXED item 3: student_get_session shown_deadline is the close time');
select t.is_true((select (public.student_get_session(t.tok('Alice'), t.sr('s3')) -> 'session' ->> 'deadline')::timestamptz = t.closes(t.sr('s3')) + interval '15 minutes'
  ), 'student_get_session deadline is still the real cutoff');
select t.reset();
select t.as_user(t.id('owner'), 'owner@a.edu');
select t.is_true((select (public.instructor_preview(t.sr('s3'), t.id('Erin')) -> 'session' ->> 'shown_deadline')::timestamptz = closes_at + interval '2 days'
                  from public.sessions where id = t.sr('s3')), 'instructor_preview shows the same shown_deadline');
select t.reset();

-- ---------------------------------------------------------------------------
-- Item 4. Questions answered out of questions the student can answer.
-- ---------------------------------------------------------------------------
insert into t.sr values ('s4', t.mk_session('progress', interval '-1 day', interval '1 day'));
insert into t.sr values ('q4a', t.mk_q(t.sr('s4'), 1, 'text', 'own_team_members'));
insert into t.sr values ('q4b', t.mk_q(t.sr('s4'), 2, 'text', 'self'));
insert into t.sr values ('q4c', t.mk_q(t.sr('s4'), 3, 'text', 'students', '{}', 'instructors'));
insert into t.sr values ('q4d', t.mk_q(t.sr('s4'), 4, 'text', 'instructors'));
select t.as_anon();
select t.lives(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Alice'), t.sr('s4'), t.sr('q4a'),
  jsonb_build_array(t.row(t.sk('Dave'), '{"text":"hi"}'))), 'Alice answers the teammates question (Dave is her teammate after the move above)');
select t.lives(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Frank'), t.sr('s4'), t.sr('q4b'),
  jsonb_build_array(t.row(t.sk('Frank'), '{"text":"me"}'))), 'Frank answers the self question');
select t.eq((select (e ->> 'questions_answered') || ' of ' || (e ->> 'questions_answerable') from t.portal_session('Alice', t.sr('s4')) e),
  '1 of 3', 'FIXED item 4: Alice has answered 1 of 3 (the instructor-giver question does not count)');
select t.eq((select (e ->> 'questions_answered') || ' of ' || (e ->> 'questions_answerable') from t.portal_session('Frank', t.sr('s4')) e),
  '1 of 2', 'Frank (team of one): the teammates question has no recipients for him and does not count');
select t.eq((select (e ->> 'questions_answered') || ' of ' || (e ->> 'questions_answerable') from t.portal_session('Erin', t.sr('s4')) e),
  '0 of 3', 'Erin has answered nothing');
select t.eq((select e ->> 'submitted' from t.portal_session('Alice', t.sr('s4')) e), 'true', 'submitted (any saved row) is still returned');
select t.reset();
update public.course_instructors set is_displayed_to_students = false where course_id = t.id('A');
select t.as_anon();
select t.eq((select (e ->> 'questions_answerable') from t.portal_session('Alice', t.sr('s4')) e), '2',
  'no instructor shown to students: the question to instructors has no recipients and does not count');
select t.reset();

-- ---------------------------------------------------------------------------
-- Item 6. copy_session: default times in the target course's time zone, results time handled.
-- ---------------------------------------------------------------------------
update public.courses set time_zone = 'Asia/Tokyo' where id = t.id('A');
insert into t.sr values ('s6', t.mk_session('open source', interval '-1 day', interval '1 day', 15));
update public.sessions set results_visibility = 'custom', results_visible_at = closes_at + interval '2 days' where id = t.sr('s6');
insert into t.sr values ('s6past', t.mk_session('old source', interval '-10 days', interval '-5 days', 15));
update public.sessions set results_visibility = 'custom', results_visible_at = closes_at + interval '1 day' where id = t.sr('s6past');
insert into t.sr values ('s6early', t.mk_session('early results', interval '-20 days', interval '-1 day', 15));
update public.sessions set results_visibility = 'custom', results_visible_at = opens_at + interval '1 day' where id = t.sr('s6early');
insert into t.sr values ('s6open', t.mk_session('at open source', interval '-1 day', interval '1 day', 15, 'at_open'));
select t.as_user(t.id('owner'), 'owner@a.edu');
insert into t.sr select 'c6', (public.copy_session(t.sr('s6'), 'copy open') ->> 'session_id')::uuid;
insert into t.sr select 'c6past', (public.copy_session(t.sr('s6past'), 'copy old') ->> 'session_id')::uuid;
insert into t.sr select 'c6early', (public.copy_session(t.sr('s6early'), 'copy early') ->> 'session_id')::uuid;
insert into t.sr select 'c6open', (public.copy_session(t.sr('s6open'), 'copy at open') ->> 'session_id')::uuid;
select t.reset();

select t.is_true((select (opens_at at time zone 'Asia/Tokyo') = ((now() at time zone 'Asia/Tokyo')::date + 1 + time '08:00')
                  from public.sessions where id = t.sr('c6')), 'FIXED item 6: the copy opens tomorrow at 08:00 in the course time zone');
select t.is_true((select (closes_at at time zone 'Asia/Tokyo') = ((now() at time zone 'Asia/Tokyo')::date + 8 + time '23:59')
                  from public.sessions where id = t.sr('c6')), 'the copy closes eight days from today at 23:59 in the course time zone');
select t.eq((select public.student_status(t.sr('c6'), t.id('Alice'))), 'not_open', 'a copy of an open session is not open');
select t.is_true((select results_visibility = 'custom' and results_visible_at = closes_at + interval '2 days' from public.sessions where id = t.sr('c6')),
  'a custom results time keeps its distance from the close time');
select t.is_true((select results_visible_at = closes_at + interval '1 day' and not public.session_is_published(s)
                  from public.sessions s where id = t.sr('c6past')), 'a results time already past moves with the close time; the copy is not published');
select t.is_true((select results_visible_at = opens_at from public.sessions where id = t.sr('c6early')),
  'a results time that would fall before the new open time becomes the open time');
select t.is_true((select results_visibility = 'at_open' and results_visible_at is null and not public.session_is_published(s)
                  from public.sessions s where id = t.sr('c6open')), 'at_open is copied; the copy is not published before it opens');
select t.is_true((select bool_and(opened_email_sent_at is null and published_at is null) from public.sessions where id in (t.sr('c6'), t.sr('c6past'))),
  'stamps are cleared as before');

-- ---------------------------------------------------------------------------
-- New functions are internal
-- ---------------------------------------------------------------------------
select t.is_true(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('contrib_team_members', 'team_key_section', 'team_key_team', 'student_shown_deadline',
                      'student_question_counts', 'session_default_times')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
         or has_function_privilege('public', p.oid, 'execute'))), 'the new helper functions are not executable by anon, authenticated or public');
select t.is_true((select count(*) = 6 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('contrib_team_members', 'team_key_section', 'team_key_team', 'student_shown_deadline',
                      'student_question_counts', 'session_default_times')), 'all six helper functions exist');
select t.is_true(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and p.proname in ('contrib_team_members', 'student_shown_deadline', 'student_question_counts')
    and not (p.proconfig @> array['search_path=public, pg_temp'])), 'SECURITY DEFINER helpers pin search_path');
rollback;
