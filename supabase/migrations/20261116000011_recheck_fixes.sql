-- Re-check fixes R1 to R3 (BUILD_NOTES/07-review.md "Re-check of fixes", 08-review-fixes.md).

-- ---------------------------------------------------------------------------
-- R2, R3. Teams are stored with each response when it is written. The keys are the team keys of the giver and
-- of the recipient (null for instructors and 'none'); the id arrays are the members of those teams at that
-- moment. Visibility compares the viewer with the stored members, so moving a student or renaming (or re-using)
-- a team label does not carry earlier responses to a new group.
-- ---------------------------------------------------------------------------
alter table public.responses
  add column giver_team_key text,
  add column recipient_team_key text,
  add column giver_team_ids uuid[],
  add column recipient_team_ids uuid[];

create function public.team_member_ids(p_course uuid, p_team_key text) returns uuid[]
language sql stable security definer set search_path = public, pg_temp
as $$
  select case when p_team_key is null then null
    else coalesce((select array_agg(s.id order by s.id) from public.students s
                   where s.course_id = p_course and 't:' || s.section || '|' || s.team = p_team_key), '{}'::uuid[]) end
$$;

-- Fills the four columns on every insert (student_submit, instructor_submit, instructor_moderate, direct inserts).
create function public.responses_stamp_teams() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_course uuid;
begin
  select s.course_id into v_course from public.sessions s where s.id = new.session_id;
  new.giver_team_key := public.team_key_of(new.giver_key);
  new.recipient_team_key := public.team_key_of(new.recipient_key);
  new.giver_team_ids := public.team_member_ids(v_course, new.giver_team_key);
  new.recipient_team_ids := public.team_member_ids(v_course, new.recipient_team_key);
  return new;
end $$;
create trigger responses_stamp_teams before insert on public.responses
  for each row execute function public.responses_stamp_teams();

-- Backfill from the current teams (the best information there is for existing rows).
update public.responses r set
  giver_team_key = public.team_key_of(r.giver_key),
  recipient_team_key = public.team_key_of(r.recipient_key),
  giver_team_ids = public.team_member_ids(public.session_course(r.session_id), public.team_key_of(r.giver_key)),
  recipient_team_ids = public.team_member_ids(public.session_course(r.session_id), public.team_key_of(r.recipient_key));

create function public.viewer_qualifies(p_list text[], p_viewer public.students, p_recipient text,
                                        p_giver_ids uuid[], p_recipient_ids uuid[])
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if 'students' = any (p_list) then return true; end if;
  if 'recipient' = any (p_list)
     and (p_recipient = 's:' || p_viewer.id::text or (p_recipient like 't:%' and p_viewer.id = any (p_recipient_ids))) then return true; end if;
  if 'giver_team_members' = any (p_list) and p_viewer.id = any (p_giver_ids) then return true; end if;
  if 'recipient_team_members' = any (p_list) and p_viewer.id = any (p_recipient_ids) then return true; end if;
  return false;
end $$;

drop function public.can_view_keys(public.questions, text, text, public.students);
create function public.can_view_keys(p_question public.questions, p_giver text, p_recipient text, p_viewer public.students,
                                     p_giver_ids uuid[], p_recipient_ids uuid[])
returns table (sees_response boolean, sees_giver_name boolean, sees_recipient_name boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_giver boolean;
  v_rec boolean;
begin
  if p_giver = 's:' || p_viewer.id::text then
    return query select true, true, true; return;
  end if;
  if not public.viewer_qualifies(p_question.show_responses_to, p_viewer, p_recipient, p_giver_ids, p_recipient_ids) then
    return query select false, false, false; return;
  end if;
  v_giver := public.viewer_qualifies(p_question.show_giver_name_to, p_viewer, p_recipient, p_giver_ids, p_recipient_ids);
  v_rec := public.viewer_qualifies(p_question.show_recipient_name_to, p_viewer, p_recipient, p_giver_ids, p_recipient_ids)
      or p_recipient = 's:' || p_viewer.id::text
      or (p_recipient like 't:%' and p_viewer.id = any (p_recipient_ids));
  if p_recipient = p_giver and not v_giver then v_rec := false; end if;
  return query select true, v_giver, v_rec;
end $$;
drop function public.viewer_qualifies(text[], public.students, text, text);

create or replace function public.can_view(p_question uuid, p_response uuid, p_viewer uuid)
returns table (sees_response boolean, sees_giver_name boolean, sees_recipient_name boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  q public.questions;
  r public.responses;
  vs public.students;
begin
  select * into q from public.questions where id = p_question;
  select * into r from public.responses where id = p_response and question_id = p_question;
  select * into vs from public.students where id = p_viewer;
  if q.id is null or r.id is null or vs.id is null then raise exception 'not_found'; end if;
  return query select * from public.can_view_keys(q, r.giver_key, r.recipient_key, vs, r.giver_team_ids, r.recipient_team_ids);
end $$;

-- ---------------------------------------------------------------------------
-- R1. The CONTRIB summary appears only after the session is closed for everyone:
-- now >= greatest(closes_at + grace, latest extension). Before that the question is returned with
-- contrib_available_after and no numbers, so editing answers cannot be used to probe the numbers.
-- R2/R3: team checks use the stored team members.
-- ---------------------------------------------------------------------------
create or replace function public.student_get_results(p_token text, p_session uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  me public.students;
  s public.sessions;
  q public.questions;
  v_questions jsonb := '[]';
  v_rows jsonb;
  v_contrib jsonb;
  v_all_closed timestamptz;
begin
  me := public.student_by_token(p_token);
  select * into s from public.sessions where id = p_session and course_id = me.course_id;
  if not found then raise exception 'not_found'; end if;
  if not public.session_is_published(s) then raise exception 'not_published'; end if;
  v_all_closed := greatest(s.closes_at + make_interval(mins => s.grace_minutes),
                           (select max(e.closes_at) from public.deadline_extensions e where e.session_id = s.id));

  for q in select * from public.questions where session_id = s.id order by number loop
    if q.type = 'contrib' then
      if 'recipient' = any (q.show_responses_to) then
        if now() < v_all_closed then
          v_questions := v_questions || jsonb_build_object(
            'id', q.id, 'number', q.number, 'type', q.type, 'brief', q.brief, 'description', q.description,
            'details', q.details, 'responses', '[]'::jsonb, 'contrib_available_after', v_all_closed);
        else
          v_contrib := public.contrib_student_view(q.id, me);
          if v_contrib is not null then
            v_questions := v_questions || jsonb_build_object(
              'id', q.id, 'number', q.number, 'type', q.type, 'brief', q.brief, 'description', q.description,
              'details', q.details, 'responses', '[]'::jsonb, 'contrib', v_contrib);
          end if;
        end if;
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
        (r.recipient_key = 's:' || me.id::text or (r.recipient_key like 't:%' and me.id = any (r.recipient_team_ids))) as recipient_is_me,
        random() as rnd
      from public.responses r
      cross join lateral public.can_view_keys(q, r.giver_key, r.recipient_key, me, r.giver_team_ids, r.recipient_team_ids) v
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
