-- Student RPCs (ARCHITECTURE.md section 8). Called with the personal token, by role anon or
-- authenticated. Every function is SECURITY DEFINER and looks the student up by token first.
-- Errors (exception message = code): invalid_token, not_found, not_open_yet, deadline_passed,
-- not_published, not_a_giver, plus every answer code listed with validate_answers().

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create function public.student_by_token(p_token text) returns public.students
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare s public.students;
begin
  if p_token is null or p_token = '' then raise exception 'invalid_token'; end if;
  select * into s from public.students where access_token = p_token;
  if not found then raise exception 'invalid_token'; end if;
  return s;
end $$;

-- Replace one giver's rows for one question in one transaction. Returns the number saved.
create function public.write_answers(p_question uuid, p_giver_key text, p_answers jsonb, p_updated_by text)
returns int
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_session uuid; v_n int;
begin
  select session_id into v_session from public.questions where id = p_question;
  perform pg_advisory_xact_lock(hashtextextended(p_question::text || '|' || p_giver_key, 0));
  delete from public.responses where question_id = p_question and giver_key = p_giver_key;
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer, giver_comment, updated_at, updated_by)
  select v_session, p_question, p_giver_key, a ->> 'recipient_key', a -> 'answer',
         nullif(btrim(coalesce(a ->> 'giver_comment', '')), ''), now(), p_updated_by
  from jsonb_array_elements(p_answers) a;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Questions for one giver, each with its resolved recipients and the giver's saved answers.
create function public.build_questions(p_session uuid, p_giver_type text, p_giver_key text) returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', q.id, 'number', q.number, 'type', q.type, 'brief', q.brief, 'description', q.description,
    'details', q.details, 'giver_type', q.giver_type, 'recipient_type', q.recipient_type,
    'max_recipients', q.max_recipients,
    'recipients', coalesce((select jsonb_agg(jsonb_build_object(
                     'recipient_key', r.recipient_key, 'display_name', r.display_name, 'team_key', r.team_key))
                   from public.question_recipients(q.id, p_giver_key) r), '[]'::jsonb),
    'answers', coalesce((select jsonb_agg(jsonb_build_object(
                     'recipient_key', x.recipient_key, 'answer', x.answer, 'giver_comment', x.giver_comment)
                     order by x.recipient_key)
                   from public.responses x where x.question_id = q.id and x.giver_key = p_giver_key), '[]'::jsonb)
  ) order by q.number), '[]'::jsonb)
  from public.questions q
  where q.session_id = p_session and q.giver_type = p_giver_type
$$;

create function public.student_session_payload(p_student public.students, p_session public.sessions) returns jsonb
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
      'status', public.student_status(p_session.id, p_student.id),
      'published', public.session_is_published(p_session)),
    'questions', public.build_questions(p_session.id, 'students', 's:' || p_student.id::text))
$$;

-- ---------------------------------------------------------------------------
-- student_portal(p_token)
-- {course:{name, code, time_zone}, student:{name, team, section, email},
--  sessions:[{id, name, opens_at, closes_at, deadline, status, published, submitted}]}
-- status is open | grace | closed (sessions that have not opened are not listed).
-- ---------------------------------------------------------------------------
create function public.student_portal(p_token text) returns jsonb
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
        'status', public.student_status(s.id, me.id),
        'published', public.session_is_published(s),
        'submitted', exists (select 1 from public.responses r where r.session_id = s.id and r.giver_key = 's:' || me.id::text))
        order by s.opens_at desc, s.name)
      from public.sessions s where s.course_id = me.course_id and s.opens_at <= now()), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- student_get_session(p_token, p_session)
-- {course:{name, code, time_zone}, student:{name, team, section},
--  session:{id, name, instructions, opens_at, closes_at, grace_minutes, deadline, status, published},
--  questions:[{id, number, type, brief, description, details, giver_type, recipient_type, max_recipients,
--              recipients:[{recipient_key, display_name, team_key}],
--              answers:[{recipient_key, answer, giver_comment}]}]}
-- ---------------------------------------------------------------------------
create function public.student_get_session(p_token text, p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare me public.students; s public.sessions;
begin
  me := public.student_by_token(p_token);
  select * into s from public.sessions where id = p_session and course_id = me.course_id;
  if not found then raise exception 'not_found'; end if;
  if now() < s.opens_at then raise exception 'not_open_yet'; end if;
  return public.student_session_payload(me, s);
end $$;

-- ---------------------------------------------------------------------------
-- student_submit(p_token, p_session, p_question, p_answers) -> {saved: n}
-- p_answers: [{recipient_key, answer, giver_comment?}]; an empty array deletes the giver's rows.
-- ---------------------------------------------------------------------------
create function public.student_submit(p_token text, p_session uuid, p_question uuid, p_answers jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare me public.students; s public.sessions; q public.questions; v_key text; v_n int;
begin
  me := public.student_by_token(p_token);
  select * into s from public.sessions where id = p_session and course_id = me.course_id;
  if not found then raise exception 'not_found'; end if;
  select * into q from public.questions where id = p_question and session_id = s.id;
  if not found then raise exception 'not_found'; end if;
  if q.giver_type <> 'students' then raise exception 'not_a_giver'; end if;
  if now() < s.opens_at then raise exception 'not_open_yet'; end if;
  if now() >= public.student_deadline(s.id, me.id) then raise exception 'deadline_passed'; end if;
  v_key := 's:' || me.id::text;
  perform public.validate_answers(q.id, v_key, p_answers);
  v_n := public.write_answers(q.id, v_key, p_answers, 'student');
  return jsonb_build_object('saved', v_n);
end $$;

-- ---------------------------------------------------------------------------
-- Contribution view for a student: {my_claim:{own, others}, team_view_of_me:{own, others}}
-- others are sorted descending. Sentinels: -999 not submitted, -9999 not available, -101 not sure.
-- Returns null when nobody in the team has answered.
-- ---------------------------------------------------------------------------
create function public.contrib_student_view(p_question uuid, p_student public.students) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  r jsonb;
  v_ids jsonb;
  v_i int;
  n int;
  v_claim jsonb;
  v_den jsonb;
begin
  r := public.contrib_team_result(p_question, 't:' || p_student.section || '|' || p_student.team);
  v_ids := r -> 'members';
  n := jsonb_array_length(v_ids);
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
    'team_view_of_me', jsonb_build_object(
      'own', v_den -> v_i,
      'others', coalesce((select jsonb_agg(e::int order by e::int desc)
                          from jsonb_array_elements_text(v_den) with ordinality t(e, o) where o - 1 <> v_i), '[]'::jsonb)));
end $$;

-- ---------------------------------------------------------------------------
-- student_get_results(p_token, p_session)
-- Raises not_published unless the session is published. Returns
-- {course:{...}, student:{...}, session:{id, name},
--  questions:[{id, number, type, brief, description, details,
--              responses:[{giver_name, recipient_name, answer, giver_comment, is_own, recipient_is_me}],
--              contrib?:{my_claim, team_view_of_me}}]}
-- Hidden names are the literal 'Anonymous'. No keys, ids or emails of other people appear, rows
-- come in a fixed order by visible names with random tie-breaks, and contrib questions never list
-- individual responses. Questions with nothing to show are left out.
-- ---------------------------------------------------------------------------
create function public.student_get_results(p_token text, p_session uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  me public.students;
  s public.sessions;
  q public.questions;
  v_questions jsonb := '[]';
  v_rows jsonb;
  v_contrib jsonb;
  v_myteam text;
begin
  me := public.student_by_token(p_token);
  select * into s from public.sessions where id = p_session and course_id = me.course_id;
  if not found then raise exception 'not_found'; end if;
  if not public.session_is_published(s) then raise exception 'not_published'; end if;
  v_myteam := 't:' || me.section || '|' || me.team;

  for q in select * from public.questions where session_id = s.id order by number loop
    if q.type = 'contrib' then
      v_contrib := null;
      if 'recipient' = any (q.show_responses_to) then
        v_contrib := public.contrib_student_view(q.id, me);
      end if;
      if v_contrib is not null then
        v_questions := v_questions || jsonb_build_object(
          'id', q.id, 'number', q.number, 'type', q.type, 'brief', q.brief, 'description', q.description,
          'details', q.details, 'responses', '[]'::jsonb, 'contrib', v_contrib);
      end if;
      continue;
    end if;

    select jsonb_agg(jsonb_build_object(
             'giver_name', x.giver_name, 'recipient_name', x.recipient_name, 'answer', x.answer,
             'giver_comment', x.giver_comment, 'is_own', x.is_own, 'recipient_is_me', x.recipient_is_me)
           order by x.recipient_name collate "C", x.giver_name collate "C", x.rnd)
      into v_rows
    from (
      select
        case when v.sees_giver_name then coalesce(public.key_display_name(s.course_id, r.giver_key), 'Anonymous') else 'Anonymous' end as giver_name,
        case when r.recipient_key = 'none' then '(no recipient)'
             when v.sees_recipient_name then coalesce(public.key_display_name(s.course_id, r.recipient_key), 'Anonymous')
             else 'Anonymous' end as recipient_name,
        r.answer, r.giver_comment,
        (r.giver_key = 's:' || me.id::text) as is_own,
        (r.recipient_key = 's:' || me.id::text or r.recipient_key = v_myteam) as recipient_is_me,
        random() as rnd
      from public.responses r
      cross join lateral public.can_view_keys(q, r.giver_key, r.recipient_key, me) v
      where r.question_id = q.id and v.sees_response
    ) x;

    if v_rows is not null then
      v_questions := v_questions || jsonb_build_object(
        'id', q.id, 'number', q.number, 'type', q.type, 'brief', q.brief, 'description', q.description,
        'details', q.details, 'responses', v_rows);
    end if;
  end loop;

  return jsonb_build_object(
    'course', (select jsonb_build_object('name', c.name, 'code', c.code, 'time_zone', c.time_zone)
               from public.courses c where c.id = s.course_id),
    'student', jsonb_build_object('name', me.name, 'team', me.team, 'section', me.section),
    'session', jsonb_build_object('id', s.id, 'name', s.name),
    'questions', v_questions);
end $$;
