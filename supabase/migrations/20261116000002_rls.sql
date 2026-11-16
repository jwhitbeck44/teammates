-- Access helpers, validation and guard triggers, and row-level security policies
-- (ARCHITECTURE.md sections 4, 5, 6, 8). Table privileges and function grants are in the
-- grants migration, which runs after every function exists.

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

-- Lowercased email of the signed-in user, or null.
create function public.jwt_email() returns text
language sql stable set search_path = public, pg_temp
as $$ select nullif(lower(btrim(auth.jwt() ->> 'email')), '') $$;

-- has_perm(course, perm): perm is one of modify_course, modify_instructors, modify_sessions,
-- modify_students, view_results, submit, or 'read' (any linked instructor of the course).
create function public.has_perm(p_course uuid, p_perm text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((
    select bool_or(case p_perm
        when 'read'               then true
        when 'view_results'       then true
        when 'modify_course'      then ci.role = 'coowner'
        when 'modify_instructors' then ci.role in ('coowner', 'manager')
        when 'modify_sessions'    then ci.role in ('coowner', 'manager')
        when 'modify_students'    then ci.role in ('coowner', 'manager')
        when 'submit'             then ci.role in ('coowner', 'manager', 'tutor')
        else false end)
    from public.course_instructors ci
    where ci.course_id = p_course
      and auth.uid() is not null
      and ci.user_id = auth.uid()
  ), false)
$$;

create function public.session_course(p_session uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$ select course_id from public.sessions where id = p_session $$;

create function public.can_create_course() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.instructor_allowlist a where a.email = public.jwt_email())
$$;

-- jsonb type helpers used by the validators
create function public.jb_is_int(j jsonb) returns boolean
language sql immutable set search_path = public, pg_temp
as $$ select coalesce(jsonb_typeof(j) = 'number' and (j #>> '{}')::numeric = trunc((j #>> '{}')::numeric), false) $$;

create function public.jb_is_num(j jsonb) returns boolean
language sql immutable set search_path = public, pg_temp
as $$ select coalesce(jsonb_typeof(j) = 'number', false) $$;

create function public.jb_is_str_array(j jsonb) returns boolean
language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(jsonb_typeof(j) = 'array'
    and not exists (select 1 from jsonb_array_elements(j) e where jsonb_typeof(e) <> 'string'), false)
$$;

-- true when key is present and not JSON null
create function public.jb_set(j jsonb, k text) returns boolean
language sql immutable set search_path = public, pg_temp
as $$ select j ? k and jsonb_typeof(j -> k) <> 'null' $$;

create function public.jb_texts(j jsonb) returns text[]
language sql immutable set search_path = public, pg_temp
as $$ select coalesce(array(select jsonb_array_elements_text(j)), '{}') $$;

-- ---------------------------------------------------------------------------
-- Email normalisation (instructor_allowlist, course_instructors, students)
-- ---------------------------------------------------------------------------
create function public.normalize_email_trg() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end $$;

create trigger instructor_allowlist_norm before insert or update on public.instructor_allowlist
  for each row execute function public.normalize_email_trg();
create trigger course_instructors_norm before insert or update on public.course_instructors
  for each row execute function public.normalize_email_trg();

-- ---------------------------------------------------------------------------
-- Courses
-- ---------------------------------------------------------------------------
create function public.courses_validate() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if btrim(coalesce(new.code, '')) = '' or btrim(coalesce(new.name, '')) = '' then
    raise exception 'required_field_missing';
  end if;
  if not exists (select 1 from pg_timezone_names z where z.name = new.time_zone) then
    raise exception 'invalid_time_zone';
  end if;
  return new;
end $$;

create trigger courses_validate before insert or update on public.courses
  for each row execute function public.courses_validate();

-- The creator becomes a coowner.
create function public.courses_add_creator() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_email text;
begin
  if new.created_by is null then return new; end if;
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = new.created_by;
  if v_email is null or v_email = '' then return new; end if;
  insert into public.course_instructors (course_id, email, user_id, display_name, role)
  values (new.id, v_email, new.created_by, coalesce(nullif(split_part(v_email, '@', 1), ''), v_email), 'coowner')
  on conflict (course_id, email) do nothing;
  return new;
end $$;

create trigger courses_add_creator after insert on public.courses
  for each row execute function public.courses_add_creator();

-- ---------------------------------------------------------------------------
-- course_instructors: keep at least one coowner; clean up responses of a removed instructor
-- ---------------------------------------------------------------------------
create function public.course_instructors_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    -- When the whole course is being deleted the parent row is already gone: allow.
    if old.role = 'coowner'
       and exists (select 1 from public.courses c where c.id = old.course_id)
       and not exists (select 1 from public.course_instructors o
                       where o.course_id = old.course_id and o.role = 'coowner' and o.id <> old.id) then
      raise exception 'last_coowner';
    end if;
    return old;
  end if;
  if old.role = 'coowner' and new.role <> 'coowner'
     and not exists (select 1 from public.course_instructors o
                     where o.course_id = old.course_id and o.role = 'coowner' and o.id <> old.id) then
    raise exception 'last_coowner';
  end if;
  return new;
end $$;

create trigger course_instructors_guard_upd before update of role on public.course_instructors
  for each row execute function public.course_instructors_guard();
create trigger course_instructors_guard_del before delete on public.course_instructors
  for each row execute function public.course_instructors_guard();

create function public.course_instructors_cleanup() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  delete from public.responses where giver_key = 'i:' || old.id::text or recipient_key = 'i:' || old.id::text;
  return old;
end $$;

create trigger course_instructors_cleanup after delete on public.course_instructors
  for each row execute function public.course_instructors_cleanup();

-- ---------------------------------------------------------------------------
-- Students: field validation (same codes as web/src/lib/validation.ts), section size, cleanup
-- ---------------------------------------------------------------------------
-- Returns the first error code for one roster row, or null when the row is valid.
create function public.student_field_error(
  p_section text, p_team text, p_name text, p_email text, p_comments text
) returns text
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  c_email_re constant text :=
    '^[^[:space:]@,;"<>()\[\]\\]+@[^[:space:]@,;"<>()\[\]\\]+\.[^[:space:]@,;"<>()\[\]\\]+$';
begin
  if btrim(coalesce(p_name, '')) = '' or btrim(coalesce(p_email, '')) = ''
     or btrim(coalesce(p_team, '')) = '' or btrim(coalesce(p_section, '')) = '' then
    return 'required_field_missing';
  end if;
  if length(p_name) > 100 or length(p_team) > 60 or length(p_section) > 60 then return 'too_long'; end if;
  if p_name ~ '[|%]' or p_team ~ '[|%]' or p_section ~ '[|%]' then return 'forbidden_char'; end if;
  if length(p_email) > 254 then return 'too_long'; end if;
  if p_email !~ c_email_re then return 'invalid_email'; end if;
  if p_comments is not null and length(p_comments) > 500 then return 'too_long'; end if;
  if p_team ~ c_email_re then return 'team_looks_like_email'; end if;
  return null;
end $$;

create function public.students_validate() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_code text;
begin
  new.section := btrim(new.section);
  new.team := btrim(new.team);
  new.name := btrim(new.name);
  new.email := lower(btrim(new.email));
  new.comments := nullif(btrim(coalesce(new.comments, '')), '');
  v_code := public.student_field_error(new.section, new.team, new.name, new.email, new.comments);
  if v_code is not null then raise exception '%', v_code; end if;
  if tg_op = 'INSERT' or new.section is distinct from old.section then
    if (select count(*) from public.students s
        where s.course_id = new.course_id and s.section = new.section and s.id <> new.id
          and s.email <> new.email) >= 100 then
      raise exception 'section_too_large';
    end if;
  end if;
  return new;
end $$;

create trigger students_validate before insert or update on public.students
  for each row execute function public.students_validate();

create function public.students_cleanup() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  delete from public.responses where giver_key = 's:' || old.id::text or recipient_key = 's:' || old.id::text;
  return old;
end $$;

create trigger students_cleanup after delete on public.students
  for each row execute function public.students_cleanup();

-- ---------------------------------------------------------------------------
-- Sessions and deadline extensions
-- ---------------------------------------------------------------------------
create function public.sessions_validate() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  new.name := btrim(new.name);
  if new.name = '' then raise exception 'required_field_missing'; end if;
  if length(new.name) > 64 then raise exception 'too_long'; end if;
  if new.name ~ '[|%]' then raise exception 'forbidden_char'; end if;
  if new.closes_at <= new.opens_at then raise exception 'invalid_time_range'; end if;
  if new.grace_minutes not in (0, 5, 10, 15, 20, 25, 30) then raise exception 'invalid_grace'; end if;
  if new.results_visibility not in ('at_open', 'custom', 'later') then raise exception 'invalid_input'; end if;
  if new.results_visibility = 'custom' and new.results_visible_at is null then
    raise exception 'invalid_time_range';
  end if;
  return new;
end $$;

create trigger sessions_validate before insert or update on public.sessions
  for each row execute function public.sessions_validate();

create function public.deadline_extensions_validate() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.closes_at <= (select s.closes_at from public.sessions s where s.id = new.session_id) then
    raise exception 'invalid_extension';
  end if;
  if not exists (select 1 from public.students st
                 join public.sessions s on s.course_id = st.course_id
                 where st.id = new.student_id and s.id = new.session_id) then
    raise exception 'not_found';
  end if;
  return new;
end $$;

create trigger deadline_extensions_validate before insert or update on public.deadline_extensions
  for each row execute function public.deadline_extensions_validate();

-- ---------------------------------------------------------------------------
-- Questions: feedback paths and validate_question()
-- ---------------------------------------------------------------------------
-- Allowed recipient types for a giver type and question type (section 6).
create function public.allowed_recipient_types(p_giver text, p_type text) returns text[]
language plpgsql immutable set search_path = public, pg_temp
as $$
declare v_base text[];
begin
  if p_type = 'contrib' then
    return case when p_giver = 'students' then array['own_team_members_including_self'] else '{}'::text[] end;
  end if;
  v_base := case p_giver
    when 'students' then array['self','students','students_excluding_self','teams','teams_excluding_self',
                               'own_team','own_team_members','own_team_members_including_self','instructors','none']
    when 'instructors' then array['self','students','teams','instructors','none']
    else '{}'::text[] end;
  if p_type in ('constsum_recipients', 'rank_recipients') then
    return array(select x from unnest(v_base) x where x not in ('self', 'own_team', 'none'));
  end if;
  return v_base;
end $$;

-- Raises '<code>' (message) with the offending field in DETAIL.
create function public.qerr(p_code text, p_field text default null) returns void
language plpgsql immutable set search_path = public, pg_temp
as $$
begin
  raise exception using message = p_code, detail = coalesce(p_field, '');
end $$;

-- Validates a question's settings and details (mirror of validateQuestion() in
-- web/src/lib/validation.ts; the first problem found is raised). Also deletes existing
-- responses when a change makes them meaningless (spec section a).
create function public.validate_question() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  d jsonb := new.details;
  v_types constant text[] := array['text','mcq','msq','numscale','constsum_options','constsum_recipients',
                                   'contrib','rubric','rank_options','rank_recipients'];
  v_vis constant text[] := array['recipient','giver_team_members','recipient_team_members','students','instructors'];
  v_list text[];
  v_field text;
  v_n int;
  v_total numeric;
  v_min numeric;
  v_max numeric;
  v_points numeric;
  v_ppo boolean;
  v_i int;
begin
  if new.type is null or not (new.type = any (v_types)) then perform public.qerr('invalid_type', 'type'); end if;
  if new.brief is null or btrim(new.brief) = '' then perform public.qerr('brief_required', 'brief'); end if;
  if new.number is null or new.number < 1 then perform public.qerr('invalid_number', 'number'); end if;
  if new.max_recipients is not null and new.max_recipients < 1 then
    perform public.qerr('invalid_max_recipients', 'max_recipients');
  end if;
  if new.giver_type is null or new.giver_type not in ('students', 'instructors') then
    perform public.qerr('invalid_giver_type', 'giver_type');
  end if;
  if new.recipient_type is null or new.recipient_type not in
     ('self','students','students_excluding_self','teams','teams_excluding_self','own_team',
      'own_team_members','own_team_members_including_self','instructors','none') then
    perform public.qerr('invalid_recipient_type', 'recipient_type');
  end if;
  if not (new.recipient_type = any (public.allowed_recipient_types(new.giver_type, new.type))) then
    perform public.qerr('invalid_path', 'recipient_type');
  end if;

  -- visibility lists
  foreach v_field in array array['show_responses_to', 'show_giver_name_to', 'show_recipient_name_to'] loop
    v_list := case v_field when 'show_responses_to' then new.show_responses_to
                           when 'show_giver_name_to' then new.show_giver_name_to
                           else new.show_recipient_name_to end;
    if not (v_list <@ v_vis) or cardinality(v_list) <> (select count(distinct x) from unnest(v_list) x) then
      perform public.qerr('invalid_visibility', v_field);
    end if;
  end loop;
  if not (new.show_giver_name_to <@ new.show_responses_to) then
    perform public.qerr('invalid_visibility', 'show_giver_name_to');
  end if;
  if not (new.show_recipient_name_to <@ new.show_responses_to) then
    perform public.qerr('invalid_visibility', 'show_recipient_name_to');
  end if;
  if new.type = 'contrib'
     and ('recipient' = any (new.show_responses_to)) <> ('giver_team_members' = any (new.show_responses_to)) then
    perform public.qerr('contrib_visibility_pair', 'show_responses_to');
  end if;

  if jsonb_typeof(d) is distinct from 'object' then perform public.qerr('invalid_input', 'details'); end if;

  case new.type
  when 'text' then
    if jb_set(d, 'recommendedLength') and (not jb_is_int(d -> 'recommendedLength') or (d ->> 'recommendedLength')::numeric < 1) then
      perform public.qerr('invalid_recommended_length', 'recommendedLength');
    end if;

  when 'mcq', 'msq' then
    if not jb_is_str_array(d -> 'choices') then perform public.qerr('invalid_input', 'choices'); end if;
    v_n := jsonb_array_length(d -> 'choices');
    if v_n < 2 then perform public.qerr('too_few_choices', 'choices'); end if;
    if exists (select 1 from jsonb_array_elements_text(d -> 'choices') c where btrim(c) = '') then
      perform public.qerr('empty_choice', 'choices');
    end if;
    if (select count(distinct btrim(c)) from jsonb_array_elements_text(d -> 'choices') c) <> v_n then
      perform public.qerr('duplicate_option', 'choices');
    end if;
    if jsonb_typeof(d -> 'otherEnabled') is distinct from 'boolean' then
      perform public.qerr('invalid_input', 'otherEnabled');
    end if;
    if new.type = 'msq' then
      v_n := v_n + case when (d ->> 'otherEnabled')::boolean then 1 else 0 end;
      if jb_set(d, 'maxSelectable') and (not jb_is_int(d -> 'maxSelectable')
          or (d ->> 'maxSelectable')::numeric < 2 or (d ->> 'maxSelectable')::numeric > v_n) then
        perform public.qerr('invalid_selectable_limits', 'maxSelectable');
      end if;
      if jb_set(d, 'minSelectable') and (not jb_is_int(d -> 'minSelectable')
          or (d ->> 'minSelectable')::numeric < 1 or (d ->> 'minSelectable')::numeric > v_n) then
        perform public.qerr('invalid_selectable_limits', 'minSelectable');
      end if;
      if jb_set(d, 'minSelectable') and jb_set(d, 'maxSelectable')
         and (d ->> 'minSelectable')::numeric > (d ->> 'maxSelectable')::numeric then
        perform public.qerr('invalid_selectable_limits', 'minSelectable');
      end if;
    end if;

  when 'numscale' then
    if not (jb_is_num(d -> 'min') and jb_is_num(d -> 'max') and jb_is_num(d -> 'step'))
       or (d ->> 'min')::numeric >= (d ->> 'max')::numeric or (d ->> 'step')::numeric <= 0 then
      perform public.qerr('invalid_scale', 'details');
    end if;

  when 'constsum_options', 'constsum_recipients' then
    v_n := null;
    if new.type = 'constsum_options' then
      if not jb_is_str_array(d -> 'options') then perform public.qerr('invalid_input', 'options'); end if;
      v_n := jsonb_array_length(d -> 'options');
      if v_n < 2 then perform public.qerr('too_few_choices', 'options'); end if;
      if exists (select 1 from jsonb_array_elements_text(d -> 'options') c where btrim(c) = '') then
        perform public.qerr('empty_choice', 'options');
      end if;
      if (select count(distinct btrim(c)) from jsonb_array_elements_text(d -> 'options') c) <> v_n then
        perform public.qerr('duplicate_option', 'options');
      end if;
    end if;
    if jsonb_typeof(d -> 'pointsPerOption') is distinct from 'boolean' then
      perform public.qerr('invalid_input', 'pointsPerOption');
    end if;
    v_ppo := (d ->> 'pointsPerOption')::boolean;
    if not jb_is_int(d -> 'points') or (d ->> 'points')::numeric < 1 then perform public.qerr('invalid_points', 'points'); end if;
    v_points := (d ->> 'points')::numeric;
    if (d ->> 'distribute') is null or jsonb_typeof(d -> 'distribute') <> 'string'
       or (d ->> 'distribute') not in ('none', 'some', 'all') then
      perform public.qerr('invalid_distribute', 'distribute');
    end if;
    -- point bounds
    v_min := null; v_max := null;
    if jb_set(d, 'minPoint') then
      if not jb_is_int(d -> 'minPoint') or (d ->> 'minPoint')::numeric < 0 then perform public.qerr('invalid_min_max_point', 'minPoint'); end if;
      v_min := (d ->> 'minPoint')::numeric;
    end if;
    if jb_set(d, 'maxPoint') then
      if not jb_is_int(d -> 'maxPoint') or (d ->> 'maxPoint')::numeric < 0 then perform public.qerr('invalid_min_max_point', 'maxPoint'); end if;
      v_max := (d ->> 'maxPoint')::numeric;
    end if;
    if v_min is not null and v_max is not null and v_min > v_max then perform public.qerr('invalid_min_max_point', 'maxPoint'); end if;
    if new.type = 'constsum_options' then v_total := case when v_ppo then v_points * v_n else v_points end;
    else v_total := case when v_ppo then null else v_points end; end if;
    if v_total is not null then
      if v_min is not null and v_min > v_total then perform public.qerr('invalid_min_max_point', 'minPoint'); end if;
      if v_max is not null and v_max > v_total then perform public.qerr('invalid_min_max_point', 'maxPoint'); end if;
      if v_n is not null and v_n > 0 then
        if v_min is not null and v_min > floor(v_total / v_n) then perform public.qerr('invalid_min_max_point', 'minPoint'); end if;
        if v_max is not null and v_max < ceil(v_total / v_n) then perform public.qerr('invalid_min_max_point', 'maxPoint'); end if;
      end if;
    end if;

  when 'contrib' then
    if jsonb_typeof(d -> 'isZeroSum') is distinct from 'boolean' or jsonb_typeof(d -> 'isNotSureAllowed') is distinct from 'boolean' then
      perform public.qerr('invalid_input', 'details');
    end if;
    if (d ->> 'isZeroSum')::boolean and (d ->> 'isNotSureAllowed')::boolean then
      perform public.qerr('contrib_conflict', 'details');
    end if;
    if new.max_recipients is not null then perform public.qerr('invalid_max_recipients', 'max_recipients'); end if;

  when 'rubric' then
    if not (jb_is_str_array(d -> 'choices') and jb_is_str_array(d -> 'subQuestions')
            and jsonb_typeof(d -> 'descriptions') = 'array') then
      perform public.qerr('invalid_rubric', 'details');
    end if;
    if exists (select 1 from jsonb_array_elements(d -> 'descriptions') r where not jb_is_str_array(r)) then
      perform public.qerr('invalid_rubric', 'details');
    end if;
    if jsonb_array_length(d -> 'choices') < 2 or jsonb_array_length(d -> 'subQuestions') < 1
       or exists (select 1 from jsonb_array_elements_text(d -> 'subQuestions') s where btrim(s) = '')
       or jsonb_array_length(d -> 'descriptions') <> jsonb_array_length(d -> 'subQuestions')
       or exists (select 1 from jsonb_array_elements(d -> 'descriptions') r
                  where jsonb_array_length(r) <> jsonb_array_length(d -> 'choices')) then
      perform public.qerr('invalid_rubric', 'details');
    end if;

  when 'rank_options', 'rank_recipients' then
    v_n := null;
    if new.type = 'rank_options' then
      if not jb_is_str_array(d -> 'options') then perform public.qerr('invalid_input', 'options'); end if;
      v_n := jsonb_array_length(d -> 'options');
      if v_n < 2 then perform public.qerr('too_few_choices', 'options'); end if;
      if exists (select 1 from jsonb_array_elements_text(d -> 'options') c where btrim(c) = '') then
        perform public.qerr('empty_choice', 'options');
      end if;
      if (select count(distinct btrim(c)) from jsonb_array_elements_text(d -> 'options') c) <> v_n then
        perform public.qerr('duplicate_option', 'options');
      end if;
    end if;
    if jsonb_typeof(d -> 'duplicatesAllowed') is distinct from 'boolean' then
      perform public.qerr('invalid_input', 'duplicatesAllowed');
    end if;
    if jb_set(d, 'minToRank') and (not jb_is_int(d -> 'minToRank') or (d ->> 'minToRank')::numeric < 1
        or (v_n is not null and (d ->> 'minToRank')::numeric > v_n)) then
      perform public.qerr('invalid_rank_limits', 'minToRank');
    end if;
    if jb_set(d, 'maxToRank') and (not jb_is_int(d -> 'maxToRank') or (d ->> 'maxToRank')::numeric < 1
        or (v_n is not null and (d ->> 'maxToRank')::numeric > v_n)) then
      perform public.qerr('invalid_rank_limits', 'maxToRank');
    end if;
    if jb_set(d, 'minToRank') and jb_set(d, 'maxToRank')
       and (d ->> 'minToRank')::numeric > (d ->> 'maxToRank')::numeric then
      perform public.qerr('invalid_rank_limits', 'minToRank');
    end if;
  end case;

  -- Existing responses stop making sense when the type, path or details (other than the
  -- advisory recommendedLength) change.
  if tg_op = 'UPDATE' and (
       old.type <> new.type or old.giver_type <> new.giver_type or old.recipient_type <> new.recipient_type
       or (old.details - 'recommendedLength') is distinct from (new.details - 'recommendedLength')) then
    delete from public.responses where question_id = old.id;
  end if;
  return new;
end $$;

create trigger questions_validate before insert or update on public.questions
  for each row execute function public.validate_question();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.instructor_allowlist enable row level security;   -- no policies: no client access
alter table public.courses enable row level security;
alter table public.course_instructors enable row level security;
alter table public.students enable row level security;
alter table public.sessions enable row level security;
alter table public.questions enable row level security;
alter table public.responses enable row level security;
alter table public.deadline_extensions enable row level security;
alter table public.email_log enable row level security;

-- courses
create policy courses_select on public.courses for select to authenticated
  using (public.has_perm(id, 'read') or created_by = auth.uid());
create policy courses_insert on public.courses for insert to authenticated
  with check (created_by = auth.uid() and public.can_create_course());
create policy courses_update on public.courses for update to authenticated
  using (public.has_perm(id, 'modify_course')) with check (public.has_perm(id, 'modify_course'));
create policy courses_delete on public.courses for delete to authenticated
  using (public.has_perm(id, 'modify_course'));

-- course_instructors: only a coowner may create, promote, demote or remove coowners
create policy ci_select on public.course_instructors for select to authenticated
  using (public.has_perm(course_id, 'read'));
create policy ci_insert on public.course_instructors for insert to authenticated
  with check (public.has_perm(course_id, 'modify_instructors')
              and (role <> 'coowner' or public.has_perm(course_id, 'modify_course')));
create policy ci_update on public.course_instructors for update to authenticated
  using (public.has_perm(course_id, 'modify_instructors')
         and (role <> 'coowner' or public.has_perm(course_id, 'modify_course')))
  with check (public.has_perm(course_id, 'modify_instructors')
              and (role <> 'coowner' or public.has_perm(course_id, 'modify_course')));
create policy ci_delete on public.course_instructors for delete to authenticated
  using (public.has_perm(course_id, 'modify_instructors')
         and (role <> 'coowner' or public.has_perm(course_id, 'modify_course')));

-- students
create policy students_select on public.students for select to authenticated
  using (public.has_perm(course_id, 'read'));
create policy students_insert on public.students for insert to authenticated
  with check (public.has_perm(course_id, 'modify_students'));
create policy students_update on public.students for update to authenticated
  using (public.has_perm(course_id, 'modify_students')) with check (public.has_perm(course_id, 'modify_students'));
create policy students_delete on public.students for delete to authenticated
  using (public.has_perm(course_id, 'modify_students'));

-- sessions
create policy sessions_select on public.sessions for select to authenticated
  using (public.has_perm(course_id, 'read'));
create policy sessions_insert on public.sessions for insert to authenticated
  with check (public.has_perm(course_id, 'modify_sessions'));
create policy sessions_update on public.sessions for update to authenticated
  using (public.has_perm(course_id, 'modify_sessions')) with check (public.has_perm(course_id, 'modify_sessions'));
create policy sessions_delete on public.sessions for delete to authenticated
  using (public.has_perm(course_id, 'modify_sessions'));

-- questions
create policy questions_select on public.questions for select to authenticated
  using (public.has_perm(public.session_course(session_id), 'read'));
create policy questions_insert on public.questions for insert to authenticated
  with check (public.has_perm(public.session_course(session_id), 'modify_sessions'));
create policy questions_update on public.questions for update to authenticated
  using (public.has_perm(public.session_course(session_id), 'modify_sessions'))
  with check (public.has_perm(public.session_course(session_id), 'modify_sessions'));
create policy questions_delete on public.questions for delete to authenticated
  using (public.has_perm(public.session_course(session_id), 'modify_sessions'));

-- deadline extensions
create policy ext_select on public.deadline_extensions for select to authenticated
  using (public.has_perm(public.session_course(session_id), 'read'));
create policy ext_insert on public.deadline_extensions for insert to authenticated
  with check (public.has_perm(public.session_course(session_id), 'modify_sessions'));
create policy ext_update on public.deadline_extensions for update to authenticated
  using (public.has_perm(public.session_course(session_id), 'modify_sessions'))
  with check (public.has_perm(public.session_course(session_id), 'modify_sessions'));
create policy ext_delete on public.deadline_extensions for delete to authenticated
  using (public.has_perm(public.session_course(session_id), 'modify_sessions'));

-- responses: read-only for instructors with view_results; written only by the RPCs
create policy responses_select on public.responses for select to authenticated
  using (public.has_perm(public.session_course(session_id), 'view_results'));

-- email_log: instructors who can modify sessions may read the log of their sessions
create policy email_log_select on public.email_log for select to authenticated
  using (session_id is not null and public.has_perm(public.session_course(session_id), 'modify_sessions'));
