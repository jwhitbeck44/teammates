-- Second review fixes (BUILD_NOTES/09-second-review-fixes.md): contribution teams from stored rows (item 2),
-- the deadline students see (item 3), questions answered per student (item 4), copy_session times (item 6).
-- Every function here is internal (no execute for anon or authenticated) unless it already was an RPC;
-- "create or replace" keeps the grants of the RPCs.

-- ---------------------------------------------------------------------------
-- Item 2. The team a student belongs to for one contrib question, taken from the stored response rows
-- (migration 11 stamps giver_team_key and giver_team_ids on every row when it is written):
--   1. a student who gave answers on the question: the team stamped on those rows (the latest row wins);
--   2. else a student listed in giver_team_ids of another giver's rows: that row's team (the latest row wins);
--   3. else the student's current team, but only when no stored row carries that team key (a team with no
--      responses uses the current roster). A student who joined a team after every answer in it was saved
--      is in no team for this question: adding them would add "not submitted" cells to the others' results.
-- Only students that still exist are returned; a deleted student is left out (students_cleanup also deleted
-- the rows they gave and received). Two givers of one team with different stored member lists (a student
-- added mid-session) give one team whose members are everyone either list names.
-- Mirror: contribTeamsFromRows() in web/src/lib/results.ts.
-- ---------------------------------------------------------------------------
create function public.contrib_team_members(p_question uuid)
returns table (student_id uuid, team_key text)
language sql stable security definer set search_path = public, pg_temp
as $$
  with q as (
    select qq.id, s.course_id from public.questions qq join public.sessions s on s.id = qq.session_id
    where qq.id = p_question),
  given as (
    select r.id, substr(r.giver_key, 3)::uuid as giver_id, r.giver_team_key, r.giver_team_ids, r.updated_at
    from public.responses r join q on q.id = r.question_id
    where r.giver_key ~ '^s:[0-9a-f-]{36}$' and r.giver_team_key is not null),
  own as (
    select distinct on (g.giver_id) g.giver_id as sid, g.giver_team_key as k
    from given g order by g.giver_id, g.updated_at desc, g.id desc),
  named as (
    select distinct on (m.sid) m.sid, g.giver_team_key as k
    from given g cross join lateral unnest(coalesce(g.giver_team_ids, '{}'::uuid[])) m(sid)
    order by m.sid, g.updated_at desc, g.id desc),
  stored as (select distinct g.giver_team_key as k from given g)
  select st.id, coalesce(own.k, named.k, 't:' || st.section || '|' || st.team)
  from public.students st join q on q.course_id = st.course_id
  left join own on own.sid = st.id
  left join named on named.sid = st.id
  where own.k is not null or named.k is not null
     or not exists (select 1 from stored where stored.k = 't:' || st.section || '|' || st.team)
$$;
revoke all on function public.contrib_team_members(uuid) from public, anon, authenticated;

create function public.team_key_section(p_team_key text) returns text
language sql immutable set search_path = public, pg_temp
as $$ select substr(p_team_key, 3, position('|' in p_team_key) - 3) $$;

create function public.team_key_team(p_team_key text) returns text
language sql immutable set search_path = public, pg_temp
as $$ select substr(p_team_key, position('|' in p_team_key) + 1) $$;
revoke all on function public.team_key_section(text), public.team_key_team(text) from public, anon, authenticated;

-- Results for one team of a contrib question. Members come from contrib_team_members (stored teams), in
-- roster order (name, then id). section and team of each member are the team's, not the student's current
-- ones. Responses whose giver or recipient is not a member are ignored; a missing response is NSB (-999).
-- Signature unchanged from migration 09.
create or replace function public.contrib_team_result(p_question uuid, p_team_key text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  q public.questions;
  v_members jsonb;
  v_ids uuid[];
  n int;
  v_matrix jsonb := '[]';
  v_row jsonb;
  v_val int;
  i int;
  j int;
begin
  select qq.* into q from public.questions qq where qq.id = p_question;
  if not found or q.type <> 'contrib' then raise exception 'not_found'; end if;

  select array_agg(m.id order by m.name collate "C", m.id),
         coalesce(jsonb_agg(jsonb_build_object('student_id', m.id,
                                               'section', public.team_key_section(p_team_key),
                                               'team', public.team_key_team(p_team_key),
                                               'name', m.name, 'email', m.email)
                            order by m.name collate "C", m.id), '[]')
    into v_ids, v_members
  from public.contrib_team_members(p_question) tm
  join public.students m on m.id = tm.student_id
  where tm.team_key = p_team_key;
  n := coalesce(cardinality(v_ids), 0);

  for i in 1..n loop
    v_row := '[]';
    for j in 1..n loop
      -- a stored value that is not a number counts as not submitted; numbers are clamped and rounded
      select case when jsonb_typeof(r.answer -> 'value') = 'number'
                  then round(least(greatest((r.answer ->> 'value')::numeric, -1000), 1000))::int end
        into v_val from public.responses r
       where r.question_id = p_question and r.giver_key = 's:' || v_ids[i]::text and r.recipient_key = 's:' || v_ids[j]::text;
      v_row := v_row || to_jsonb(coalesce(v_val, -999));
      v_val := null;
    end loop;
    v_matrix := v_matrix || jsonb_build_array(v_row);
  end loop;

  return jsonb_build_object('team_key', p_team_key, 'members', v_members, 'claimed', v_matrix)
         || public.contrib_calc(v_matrix);
end $$;

-- A student's own view uses the team the student was rated in (contrib_team_members), so a student who
-- moved to another team after the session still sees the numbers of the old team. Otherwise as migration 09.
create or replace function public.contrib_student_view(p_question uuid, p_student public.students) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  r jsonb;
  v_team text;
  v_ids jsonb;
  v_i int;
  v_claim jsonb;
  v_den jsonb;
begin
  select tm.team_key into v_team from public.contrib_team_members(p_question) tm where tm.student_id = p_student.id;
  if v_team is null then return null; end if;
  r := public.contrib_team_result(p_question, v_team);
  v_ids := r -> 'members';
  select (o - 1)::int into v_i from jsonb_array_elements(v_ids) with ordinality m(e, o)
   where (m.e ->> 'student_id')::uuid = p_student.id;
  if v_i is null then return null; end if;
  if not exists (select 1 from jsonb_array_elements(r -> 'claimed') row, jsonb_array_elements_text(row.value) c where c <> '-999') then
    return null;
  end if;
  v_claim := (r -> 'claimed') -> v_i;
  v_den := (r -> 'denormalizedAveragePerceived') -> v_i;
  return jsonb_build_object(
    'my_claim', jsonb_build_object(
      'own', v_claim -> v_i,
      'others', coalesce((select jsonb_agg(e::int order by e::int desc)
                          from jsonb_array_elements_text(v_claim) with ordinality t(e, o) where o - 1 <> v_i), '[]'::jsonb)),
    'team_view_of_me', jsonb_build_object('own', v_den -> v_i));
end $$;

-- Instructor table: one block per stored team (contrib_team_members), ordered by section then team.
-- Output shape unchanged; section, team and team_key are the stored team's.
create or replace function public.instructor_contrib_results(p_question uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  q public.questions;
  v_course uuid;
  t record;
  r jsonb;
  m jsonb;
  i int;
  n int;
  v_claimed int;
  v_perceived int;
  v_out jsonb := '[]';
begin
  select * into q from public.questions where id = p_question;
  if not found then raise exception 'forbidden'; end if;
  v_course := public.session_course(q.session_id);
  if not public.has_perm(v_course, 'view_results') then raise exception 'forbidden'; end if;
  if q.type <> 'contrib' then raise exception 'not_found'; end if;

  for t in select x.team_key, public.team_key_section(x.team_key) as section, public.team_key_team(x.team_key) as team
           from (select distinct tm.team_key from public.contrib_team_members(p_question) tm) x
           order by public.team_key_section(x.team_key) collate "C", public.team_key_team(x.team_key) collate "C" loop
    r := public.contrib_team_result(p_question, t.team_key);
    n := jsonb_array_length(r -> 'members');
    for i in 0..n - 1 loop
      m := (r -> 'members') -> i;
      v_claimed := ((r -> 'normalizedClaimed') -> i ->> i)::int;
      v_perceived := ((r -> 'normalizedAveragePerceived') ->> i)::int;
      v_out := v_out || jsonb_build_object(
        'student_id', m -> 'student_id', 'section', t.section, 'team', t.team,
        'team_key', t.team_key,
        'name', m -> 'name', 'email', m -> 'email',
        'claimed', v_claimed, 'perceived', v_perceived,
        'diff', case when v_claimed < 0 or v_perceived < 0 then -999 else v_perceived - v_claimed end,
        'ratings_received', coalesce((
            select jsonb_agg(x.v order by x.v desc)
            from (select (((r -> 'normalizedPeerContributionRatio') -> g) ->> i)::int as v
                  from generate_series(0, n - 1) g where g <> i) x), '[]'::jsonb));
    end loop;
  end loop;
  return jsonb_build_object('question_id', p_question, 'students', v_out);
end $$;

-- ---------------------------------------------------------------------------
-- Item 3. The deadline a student is shown: the student's extension if there is one, else the close time.
-- No grace period. Same rule as studentShownDeadline in supabase/functions/_shared/due.ts (emails) and
-- shownDeadline in web/src/lib/time.ts. The real cutoff stays student_deadline().
-- ---------------------------------------------------------------------------
create function public.student_shown_deadline(p_session uuid, p_student uuid) returns timestamptz
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    (select e.closes_at from public.deadline_extensions e where e.session_id = s.id and e.student_id = p_student),
    s.closes_at)
  from public.sessions s where s.id = p_session
$$;
revoke all on function public.student_shown_deadline(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Item 4. Questions a student can answer (giver students, at least one resolved recipient) and how many of
-- those have at least one saved row. A question with no recipients for the student (a team of one on a
-- teammates question) is not counted. Mirrors questionProgress() in web/src/lib/results.ts and
-- hasRecipients() in supabase/functions/_shared/due.ts.
-- ---------------------------------------------------------------------------
create function public.student_question_counts(p_session uuid, p_student uuid)
returns table (answerable int, answered int)
language sql stable security definer set search_path = public, pg_temp
as $$
  select count(*)::int,
         count(*) filter (where exists (select 1 from public.responses r
                                        where r.question_id = q.id and r.giver_key = 's:' || p_student::text))::int
  from public.questions q
  where q.session_id = p_session and q.giver_type = 'students'
    and exists (select 1 from public.question_recipients(q.id, 's:' || p_student::text))
$$;
revoke all on function public.student_question_counts(uuid, uuid) from public, anon, authenticated;

-- Session payload: adds shown_deadline. deadline stays the real cutoff (close + grace, or the extension).
create or replace function public.student_session_payload(p_student public.students, p_session public.sessions) returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'course', (select jsonb_build_object('name', c.name, 'code', c.code, 'time_zone', c.time_zone)
               from public.courses c where c.id = p_session.course_id),
    'student', jsonb_build_object('name', p_student.name, 'team', p_student.team, 'section', p_student.section),
    'session', jsonb_build_object(
      'id', p_session.id, 'name', p_session.name, 'instructions', p_session.instructions,
      'opens_at', p_session.opens_at, 'closes_at', p_session.closes_at, 'grace_minutes', p_session.grace_minutes,
      'deadline', public.student_deadline(p_session.id, p_student.id),
      'shown_deadline', public.student_shown_deadline(p_session.id, p_student.id),
      'status', public.student_status(p_session.id, p_student.id),
      'published', public.session_is_published(p_session)),
    'questions', public.build_questions(p_session.id, 'students', 's:' || p_student.id::text))
$$;

-- Portal: adds shown_deadline, questions_answerable and questions_answered per session. submitted (at least
-- one saved row) is kept for older clients.
create or replace function public.student_portal(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare me public.students;
begin
  me := public.student_by_token(p_token);
  return jsonb_build_object(
    'course', (select jsonb_build_object('name', c.name, 'code', c.code, 'time_zone', c.time_zone)
               from public.courses c where c.id = me.course_id),
    'student', jsonb_build_object('name', me.name, 'team', me.team, 'section', me.section, 'email', me.email),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'opens_at', s.opens_at, 'closes_at', s.closes_at,
        'deadline', public.student_deadline(s.id, me.id),
        'shown_deadline', public.student_shown_deadline(s.id, me.id),
        'status', public.student_status(s.id, me.id),
        'published', public.session_is_published(s),
        'submitted', exists (select 1 from public.responses r where r.session_id = s.id and r.giver_key = 's:' || me.id::text),
        'questions_answerable', qc.answerable,
        'questions_answered', qc.answered)
        order by s.opens_at desc, s.name)
      from public.sessions s
      cross join lateral public.student_question_counts(s.id, me.id) qc
      where s.course_id = me.course_id and s.opens_at <= now()), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Item 6. copy_session gives the copy the same default times as a new session (defaultSessionTimes in
-- web/src/lib/time.ts): opens tomorrow at 08:00, closes eight days from today at 23:59, both in the target
-- course's time zone. A custom results time keeps its distance from the close time, and is moved to the
-- open time if that would be earlier. at_open and later are copied as they are.
-- ---------------------------------------------------------------------------
create function public.session_default_times(p_time_zone text, out opens_at timestamptz, out closes_at timestamptz)
language sql stable set search_path = public, pg_temp
as $$
  select ((now() at time zone p_time_zone)::date + 1 + time '08:00') at time zone p_time_zone,
         ((now() at time zone p_time_zone)::date + 8 + time '23:59') at time zone p_time_zone
$$;
revoke all on function public.session_default_times(text) from public, anon, authenticated;

create or replace function public.copy_session(p_session uuid, p_new_name text, p_target_course uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  s public.sessions;
  v_target uuid;
  v_new uuid;
  v_tz text;
  v_opens timestamptz;
  v_closes timestamptz;
  v_results timestamptz;
begin
  select * into s from public.sessions where id = p_session;
  if not found or not public.has_perm(s.course_id, 'modify_sessions') then raise exception 'forbidden'; end if;
  v_target := coalesce(p_target_course, s.course_id);
  if not public.has_perm(v_target, 'modify_sessions') then raise exception 'forbidden'; end if;
  select c.time_zone into v_tz from public.courses c where c.id = v_target;
  select d.opens_at, d.closes_at into v_opens, v_closes from public.session_default_times(v_tz) d;
  if s.results_visibility = 'custom' and s.results_visible_at is not null then
    v_results := greatest(v_closes + (s.results_visible_at - s.closes_at), v_opens);
  end if;
  begin
    insert into public.sessions (course_id, name, instructions, opens_at, closes_at, grace_minutes,
                                 results_visibility, results_visible_at, closing_email_enabled,
                                 published_email_enabled, created_by)
    values (v_target, p_new_name, s.instructions, v_opens, v_closes, s.grace_minutes,
            s.results_visibility, v_results, s.closing_email_enabled,
            s.published_email_enabled, auth.uid())
    returning id into v_new;
  exception when unique_violation then
    raise exception 'name_taken';
  end;
  insert into public.questions (session_id, number, type, brief, description, details, giver_type,
                                recipient_type, max_recipients, show_responses_to, show_giver_name_to,
                                show_recipient_name_to)
  select v_new, q.number, q.type, q.brief, q.description, q.details, q.giver_type, q.recipient_type,
         q.max_recipients, q.show_responses_to, q.show_giver_name_to, q.show_recipient_name_to
  from public.questions q where q.session_id = s.id;
  return jsonb_build_object('session_id', v_new);
end $$;
