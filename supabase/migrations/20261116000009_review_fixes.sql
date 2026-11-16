-- Review fixes F1 to F4, F8 to F10 (BUILD_NOTES/07-review.md, 08-review-fixes.md).

-- ---------------------------------------------------------------------------
-- F1. Integers must be JSON integers in canonical form (no 100.0, no 1e2).
-- Rejected with the existing invalid_answer / invalid_input family. Also, the contrib matrix
-- builder never raises on a bad stored value: it clamps numbers and treats anything else as missing.
-- ---------------------------------------------------------------------------
create or replace function public.jb_is_int(j jsonb) returns boolean
language sql immutable set search_path = public, pg_temp
as $$ select coalesce(jsonb_typeof(j) = 'number' and (j #>> '{}') ~ '^-?[0-9]{1,15}$', false) $$;

create or replace function public.contrib_team_result(p_question uuid, p_team_key text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  q public.questions;
  v_course uuid;
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
  select s.course_id into v_course from public.sessions s where s.id = q.session_id;

  select array_agg(m.id order by m.name collate "C", m.id),
         coalesce(jsonb_agg(jsonb_build_object('student_id', m.id, 'section', m.section, 'team', m.team,
                                               'name', m.name, 'email', m.email)
                            order by m.name collate "C", m.id), '[]')
    into v_ids, v_members
  from public.students m
  where m.course_id = v_course and 't:' || m.section || '|' || m.team = p_team_key;
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

-- ---------------------------------------------------------------------------
-- F2. students.access_token is not readable by clients. Column-level SELECT without it, and one RPC
-- for the links (modify_students only).
-- ---------------------------------------------------------------------------
revoke select on public.students from authenticated;
grant select (id, course_id, section, team, name, email, comments, created_at) on public.students to authenticated;

create function public.instructor_student_links(p_course uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not public.has_perm(p_course, 'modify_students') then raise exception 'forbidden'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('student_id', s.id, 'section', s.section, 'team', s.team,
                                        'name', s.name, 'email', s.email, 'token', s.access_token)
                     order by s.section collate "C", s.team collate "C", s.name collate "C", s.id)
    from public.students s where s.course_id = p_course), '[]'::jsonb);
end $$;
grant execute on function public.instructor_student_links(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- F3. Once a question has responses, nothing may be ADDED to its three visibility lists. Runs after
-- questions_validate (trigger names fire in order), which has already deleted the responses when the
-- type, path or details changed, so such a change is not blocked.
-- ---------------------------------------------------------------------------
create function public.questions_visibility_lock() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if (exists (select 1 from unnest(new.show_responses_to) e where not e = any (old.show_responses_to))
      or exists (select 1 from unnest(new.show_giver_name_to) e where not e = any (old.show_giver_name_to))
      or exists (select 1 from unnest(new.show_recipient_name_to) e where not e = any (old.show_recipient_name_to)))
     and exists (select 1 from public.responses r where r.question_id = old.id) then
    perform public.qerr('visibility_locked', 'show_responses_to');
  end if;
  return new;
end $$;

create trigger questions_visibility_lock before update on public.questions
  for each row execute function public.questions_visibility_lock();

-- ---------------------------------------------------------------------------
-- F4. A student no longer gets the team's view of her teammates, only of herself.
-- ---------------------------------------------------------------------------
create or replace function public.contrib_student_view(p_question uuid, p_student public.students) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  r jsonb;
  v_ids jsonb;
  v_i int;
  v_claim jsonb;
  v_den jsonb;
begin
  r := public.contrib_team_result(p_question, 't:' || p_student.section || '|' || p_student.team);
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

-- ---------------------------------------------------------------------------
-- F8. When the recipient is the giver and the giver name is hidden, the recipient name is hidden too.
-- ---------------------------------------------------------------------------
create or replace function public.can_view_keys(p_question public.questions, p_giver text, p_recipient text, p_viewer public.students)
returns table (sees_response boolean, sees_giver_name boolean, sees_recipient_name boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_own boolean := p_giver = 's:' || p_viewer.id::text;
  v_resp boolean;
  v_giver boolean;
  v_rec boolean;
begin
  if v_own then
    return query select true, true, true; return;
  end if;
  v_resp := public.viewer_qualifies(p_question.show_responses_to, p_viewer, p_giver, p_recipient);
  if not v_resp then
    return query select false, false, false; return;
  end if;
  v_giver := public.viewer_qualifies(p_question.show_giver_name_to, p_viewer, p_giver, p_recipient);
  v_rec := public.viewer_qualifies(p_question.show_recipient_name_to, p_viewer, p_giver, p_recipient)
      or p_recipient = 's:' || p_viewer.id::text
      or p_recipient = 't:' || p_viewer.section || '|' || p_viewer.team;
  -- the recipient name would give away a hidden giver
  if p_recipient = p_giver and not v_giver then v_rec := false; end if;
  return query select true, v_giver, v_rec;
end $$;

-- ---------------------------------------------------------------------------
-- F9. Size limits and canonical answers. validate_answers keeps its body as validate_answers_core;
-- the new validate_answers runs it and then checks lengths. write_answers stores only the keys of the type.
-- ---------------------------------------------------------------------------
alter function public.validate_answers(uuid, text, jsonb) rename to validate_answers_core;

create function public.validate_answers(p_question uuid, p_giver_key text, p_answers jsonb) returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a jsonb;
begin
  perform public.validate_answers_core(p_question, p_giver_key, p_answers);
  for a in select value from jsonb_array_elements(p_answers) loop
    if length(coalesce(a -> 'answer' ->> 'text', '')) > 10000 or length(coalesce(a -> 'answer' ->> 'other', '')) > 10000
       or length(coalesce(a ->> 'giver_comment', '')) > 2000 then
      perform public.aerr('too_long', a ->> 'recipient_key');
    end if;
  end loop;
end $$;

create function public.canonical_answer(p_type text, p_answer jsonb) returns jsonb
language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(k, p_answer -> k), '{}'::jsonb)
  from unnest(case p_type
    when 'text' then array['text']
    when 'mcq' then array['choice', 'other']
    when 'msq' then array['choices', 'other']
    when 'numscale' then array['value']
    when 'constsum_options' then array['points']
    when 'constsum_recipients' then array['points']
    when 'contrib' then array['value']
    when 'rubric' then array['choices']
    when 'rank_options' then array['ranks']
    when 'rank_recipients' then array['rank']
    else array[]::text[] end) k
  where p_answer ? k
$$;

create or replace function public.write_answers(p_question uuid, p_giver_key text, p_answers jsonb, p_updated_by text)
returns int
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_session uuid; v_type text; v_n int;
begin
  select session_id, type into v_session, v_type from public.questions where id = p_question;
  perform pg_advisory_xact_lock(hashtextextended(p_question::text || '|' || p_giver_key, 0));
  delete from public.responses where question_id = p_question and giver_key = p_giver_key;
  insert into public.responses (session_id, question_id, giver_key, recipient_key, answer, giver_comment, updated_at, updated_by)
  select v_session, p_question, p_giver_key, a ->> 'recipient_key', public.canonical_answer(v_type, a -> 'answer'),
         nullif(btrim(coalesce(a ->> 'giver_comment', '')), ''), now(), p_updated_by
  from jsonb_array_elements(p_answers) a;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- F10. session_course answers only for sessions of a course the caller belongs to. A call with no JWT
-- (cron, service role, definer code run by the owner) is unchanged. RLS policies keep working because
-- every row a user may touch belongs to one of their courses.
-- ---------------------------------------------------------------------------
create or replace function public.session_course(p_session uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select s.course_id from public.sessions s
  where s.id = p_session and (auth.uid() is null or public.has_perm(s.course_id, 'read'))
$$;
