-- Instructor RPCs (ARCHITECTURE.md section 8). Role authenticated only. All are SECURITY DEFINER
-- and check has_perm() themselves; a missing permission, a missing row and an unknown id all raise
-- 'forbidden' so ids cannot be probed. Other codes: not_found, not_a_giver, not_open_yet,
-- deadline_passed, already_published, not_published, name_taken, invalid_input, plus the roster,
-- session and answer codes documented in BUILD_NOTES/01-database.md.

-- ---------------------------------------------------------------------------
-- claim_instructor_invites() -> {claimed: n}
-- Links every unclaimed course_instructors row whose email matches the signed-in user's confirmed
-- email. The app calls it after every sign-in.
-- ---------------------------------------------------------------------------
create function public.claim_instructor_invites() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_email text; v_n int;
begin
  if auth.uid() is null then raise exception 'forbidden'; end if;
  select lower(btrim(u.email)) into v_email from auth.users u
   where u.id = auth.uid() and u.email_confirmed_at is not null;
  if v_email is null or v_email = '' then return jsonb_build_object('claimed', 0); end if;
  update public.course_instructors ci set user_id = auth.uid()
   where ci.email = v_email and ci.user_id is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('claimed', v_n);
end $$;

-- ---------------------------------------------------------------------------
-- instructor_submit(p_session, p_question, p_answers) -> {saved: n}
-- Answers an instructor-giver question as the signed-in instructor (needs 'submit').
-- Allowed from opens_at until closes_at + grace.
-- ---------------------------------------------------------------------------
create function public.instructor_submit(p_session uuid, p_question uuid, p_answers jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare s public.sessions; q public.questions; ins public.course_instructors; v_key text; v_n int;
begin
  select * into s from public.sessions where id = p_session;
  if not found or not public.has_perm(s.course_id, 'submit') then raise exception 'forbidden'; end if;
  select * into q from public.questions where id = p_question and session_id = s.id;
  if not found then raise exception 'not_found'; end if;
  if q.giver_type <> 'instructors' then raise exception 'not_a_giver'; end if;
  select * into ins from public.course_instructors where course_id = s.course_id and user_id = auth.uid();
  if not found then raise exception 'forbidden'; end if;
  if now() < s.opens_at then raise exception 'not_open_yet'; end if;
  if now() >= s.closes_at + make_interval(mins => s.grace_minutes) then raise exception 'deadline_passed'; end if;
  v_key := 'i:' || ins.id::text;
  perform public.validate_answers(q.id, v_key, p_answers);
  v_n := public.write_answers(q.id, v_key, p_answers, 'instructor');
  return jsonb_build_object('saved', v_n);
end $$;

-- ---------------------------------------------------------------------------
-- instructor_get_submission(p_session)
-- Same shape as student_get_session but for the signed-in instructor's own questions:
-- {course, instructor:{id, display_name}, session:{id, name, instructions, opens_at, closes_at,
--  grace_minutes, deadline, status, published}, questions:[...]}. Needs 'submit'.
-- ---------------------------------------------------------------------------
create function public.instructor_get_submission(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare s public.sessions; ins public.course_instructors;
begin
  select * into s from public.sessions where id = p_session;
  if not found or not public.has_perm(s.course_id, 'submit') then raise exception 'forbidden'; end if;
  select * into ins from public.course_instructors where course_id = s.course_id and user_id = auth.uid();
  if not found then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'course', (select jsonb_build_object('name', c.name, 'code', c.code, 'time_zone', c.time_zone)
               from public.courses c where c.id = s.course_id),
    'instructor', jsonb_build_object('id', ins.id, 'display_name', ins.display_name),
    'session', jsonb_build_object(
      'id', s.id, 'name', s.name, 'instructions', s.instructions, 'opens_at', s.opens_at,
      'closes_at', s.closes_at, 'grace_minutes', s.grace_minutes,
      'deadline', s.closes_at + make_interval(mins => s.grace_minutes),
      'status', case when now() < s.opens_at then 'not_open'
                     when now() < s.closes_at then 'open'
                     when now() < s.closes_at + make_interval(mins => s.grace_minutes) then 'grace'
                     else 'closed' end,
      'published', public.session_is_published(s)),
    'questions', public.build_questions(s.id, 'instructors', 'i:' || ins.id::text));
end $$;

-- ---------------------------------------------------------------------------
-- instructor_moderate(p_session, p_question, p_student, p_answers) -> {saved: n}
-- Replaces a student's answers; ignores open and close times; updated_by = instructor email.
-- ---------------------------------------------------------------------------
create function public.instructor_moderate(p_session uuid, p_question uuid, p_student uuid, p_answers jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare s public.sessions; q public.questions; st public.students; v_key text; v_n int;
begin
  select * into s from public.sessions where id = p_session;
  if not found or not public.has_perm(s.course_id, 'modify_sessions') then raise exception 'forbidden'; end if;
  select * into q from public.questions where id = p_question and session_id = s.id;
  if not found then raise exception 'not_found'; end if;
  select * into st from public.students where id = p_student and course_id = s.course_id;
  if not found then raise exception 'not_found'; end if;
  if q.giver_type <> 'students' then raise exception 'not_a_giver'; end if;
  v_key := 's:' || st.id::text;
  perform public.validate_answers(q.id, v_key, p_answers);
  v_n := public.write_answers(q.id, v_key, p_answers, coalesce(public.jwt_email(), 'instructor'));
  return jsonb_build_object('saved', v_n);
end $$;

-- ---------------------------------------------------------------------------
-- instructor_preview(p_session, p_student): the student_get_session payload for that student,
-- without the not-open check. Needs modify_sessions.
-- ---------------------------------------------------------------------------
create function public.instructor_preview(p_session uuid, p_student uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare s public.sessions; st public.students;
begin
  select * into s from public.sessions where id = p_session;
  if not found or not public.has_perm(s.course_id, 'modify_sessions') then raise exception 'forbidden'; end if;
  select * into st from public.students where id = p_student and course_id = s.course_id;
  if not found then raise exception 'not_found'; end if;
  return public.student_session_payload(st, s);
end $$;

-- ---------------------------------------------------------------------------
-- instructor_contrib_results(p_question)
-- {question_id, students:[{student_id, section, team, team_key, name, email,
--   claimed, perceived, diff, ratings_received:[int]}]}   (needs view_results)
-- claimed = normalizedClaimed[i][i], perceived = normalizedAveragePerceived[i],
-- diff = perceived - claimed or -999 when either is negative, ratings_received sorted descending
-- (sentinels -999/-9999/-101 are kept). Students are in roster order; every team with students is listed.
-- ---------------------------------------------------------------------------
create function public.instructor_contrib_results(p_question uuid) returns jsonb
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

  for t in select x.section, x.team
           from (select distinct s.section, s.team from public.students s where s.course_id = v_course) x
           order by x.section collate "C", x.team collate "C" loop
    r := public.contrib_team_result(p_question, 't:' || t.section || '|' || t.team);
    n := jsonb_array_length(r -> 'members');
    for i in 0..n - 1 loop
      m := (r -> 'members') -> i;
      v_claimed := ((r -> 'normalizedClaimed') -> i ->> i)::int;
      v_perceived := ((r -> 'normalizedAveragePerceived') ->> i)::int;
      v_out := v_out || jsonb_build_object(
        'student_id', m -> 'student_id', 'section', t.section, 'team', t.team,
        'team_key', 't:' || t.section || '|' || t.team,
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
-- regenerate_student_token(p_student) -> {access_token}   (needs modify_students)
-- ---------------------------------------------------------------------------
create function public.regenerate_student_token(p_student uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare st public.students; v_token text;
begin
  select * into st from public.students where id = p_student;
  if not found or not public.has_perm(st.course_id, 'modify_students') then raise exception 'forbidden'; end if;
  v_token := public.new_access_token();
  update public.students set access_token = v_token where id = st.id;
  return jsonb_build_object('access_token', v_token);
end $$;

-- ---------------------------------------------------------------------------
-- publish_session(p_session) -> {published: true, published_at}
-- unpublish_session(p_session) -> {published: false}        (both need modify_sessions)
-- ---------------------------------------------------------------------------
create function public.publish_session(p_session uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare s public.sessions; v_at timestamptz := now();
begin
  select * into s from public.sessions where id = p_session for update;
  if not found or not public.has_perm(s.course_id, 'modify_sessions') then raise exception 'forbidden'; end if;
  if public.session_is_published(s) then raise exception 'already_published'; end if;
  if now() < s.opens_at then raise exception 'not_open_yet'; end if;
  update public.sessions set published_at = v_at where id = s.id;
  return jsonb_build_object('published', true, 'published_at', v_at);
end $$;

create function public.unpublish_session(p_session uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare s public.sessions;
begin
  select * into s from public.sessions where id = p_session for update;
  if not found or not public.has_perm(s.course_id, 'modify_sessions') then raise exception 'forbidden'; end if;
  if not public.session_is_published(s) then raise exception 'not_published'; end if;
  update public.sessions
     set published_at = null, results_visibility = 'later', published_email_sent_at = null
   where id = s.id;
  return jsonb_build_object('published', false);
end $$;

-- ---------------------------------------------------------------------------
-- copy_session(p_session, p_new_name, p_target_course default null) -> {session_id}
-- Copies settings and questions as they are (times are not shifted); clears the published stamp
-- and the sent-email stamps. Needs modify_sessions in the source and the target course.
-- ---------------------------------------------------------------------------
create function public.copy_session(p_session uuid, p_new_name text, p_target_course uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare s public.sessions; v_target uuid; v_new uuid;
begin
  select * into s from public.sessions where id = p_session;
  if not found or not public.has_perm(s.course_id, 'modify_sessions') then raise exception 'forbidden'; end if;
  v_target := coalesce(p_target_course, s.course_id);
  if not public.has_perm(v_target, 'modify_sessions') then raise exception 'forbidden'; end if;
  begin
    insert into public.sessions (course_id, name, instructions, opens_at, closes_at, grace_minutes,
                                 results_visibility, results_visible_at, closing_email_enabled,
                                 published_email_enabled, created_by)
    values (v_target, p_new_name, s.instructions, s.opens_at, s.closes_at, s.grace_minutes,
            s.results_visibility, s.results_visible_at, s.closing_email_enabled,
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

-- ---------------------------------------------------------------------------
-- enroll_students(p_course, p_rows) -> {created, updated, errors: [{row, code}]}
-- p_rows: [{section, team, name, email, comments}]. Upserts by email. All or nothing: when any row
-- has an error nothing is written and created/updated are 0. row is 1-based. Blank section and
-- team become 'Default Section' and 'Default Team'. Codes: required_field_missing, too_long,
-- forbidden_char, invalid_email, team_looks_like_email, duplicate_email (second and later
-- occurrence), section_too_large (every incoming row of a section whose final size exceeds 100),
-- invalid_input (row is not an object).
-- ---------------------------------------------------------------------------
create function public.enroll_students(p_course uuid, p_rows jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_errors jsonb; v_created int; v_updated int;
begin
  if not public.has_perm(p_course, 'modify_students') then raise exception 'forbidden'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'invalid_input'; end if;

  create temporary table if not exists _enroll_in (
    ord int primary key, is_obj boolean, section text, team text, name text, email text, comments text,
    code text, is_new boolean) on commit drop;
  truncate _enroll_in;

  insert into _enroll_in (ord, is_obj, section, team, name, email, comments)
  select r.o::int, jsonb_typeof(r.e) = 'object',
         coalesce(nullif(btrim(r.e ->> 'section'), ''), 'Default Section'),
         coalesce(nullif(btrim(r.e ->> 'team'), ''), 'Default Team'),
         btrim(coalesce(r.e ->> 'name', '')),
         lower(btrim(coalesce(r.e ->> 'email', ''))),
         nullif(btrim(coalesce(r.e ->> 'comments', '')), '')
  from jsonb_array_elements(p_rows) with ordinality r(e, o);

  update _enroll_in set code = 'invalid_input' where not is_obj;
  update _enroll_in i set code = public.student_field_error(i.section, i.team, i.name, i.email, i.comments)
   where i.is_obj;
  update _enroll_in i set code = 'duplicate_email'
   where i.code is null and exists (select 1 from _enroll_in j where j.email = i.email and j.ord < i.ord);

  -- final section sizes: existing students not being replaced plus incoming rows
  update _enroll_in i set code = 'section_too_large'
   where i.code is null and (
     (select count(*) from public.students s
       where s.course_id = p_course and s.section = i.section
         and not exists (select 1 from _enroll_in x where x.email = s.email))
     + (select count(*) from _enroll_in x where x.section = i.section)) > 100;

  select coalesce(jsonb_agg(jsonb_build_object('row', ord, 'code', code) order by ord), '[]')
    into v_errors from _enroll_in where code is not null;
  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('created', 0, 'updated', 0, 'errors', v_errors);
  end if;

  update _enroll_in i set is_new = not exists (
    select 1 from public.students s where s.course_id = p_course and s.email = i.email);
  select count(*) filter (where is_new), count(*) filter (where not is_new) into v_created, v_updated from _enroll_in;

  insert into public.students (course_id, section, team, name, email, comments)
  select p_course, i.section, i.team, i.name, i.email, i.comments from _enroll_in i order by i.ord
  on conflict (course_id, email) do update
    set section = excluded.section, team = excluded.team, name = excluded.name, comments = excluded.comments;

  return jsonb_build_object('created', v_created, 'updated', v_updated, 'errors', '[]'::jsonb);
end $$;
