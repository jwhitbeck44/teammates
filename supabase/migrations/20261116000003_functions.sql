-- Internal functions: derived session values, recipient resolution, answer validation,
-- student visibility, and the contribution calculation (ARCHITECTURE.md sections 5 to 9).
-- Nothing here is granted to anon; the grants migration exposes only the RPCs.

-- ---------------------------------------------------------------------------
-- Derived session values (section 5)
-- ---------------------------------------------------------------------------
create function public.session_is_published(s public.sessions) returns boolean
language sql stable set search_path = public, pg_temp
as $$
  select s.published_at is not null
      or (s.results_visibility = 'at_open' and now() >= s.opens_at)
      or (s.results_visibility = 'custom' and now() >= s.results_visible_at)
$$;

create function public.session_is_published(p_session uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select public.session_is_published(s) from public.sessions s where s.id = p_session), false)
$$;

-- Lead decision (TEAMMATES rule): greatest(extension closes_at, closes_at + grace) when an extension
-- exists, else closes_at + grace.
create function public.student_deadline(p_session uuid, p_student uuid) returns timestamptz
language sql stable security definer set search_path = public, pg_temp
as $$
  select greatest(
    (select e.closes_at from public.deadline_extensions e where e.session_id = s.id and e.student_id = p_student),
    s.closes_at + make_interval(mins => s.grace_minutes))
  from public.sessions s where s.id = p_session
$$;

-- 'not_open', 'open', 'grace' or 'closed' for one student. Open from opens_at until closes_at (or until
-- the student's extension ends); grace until closes_at + grace; closed after the student's deadline.
create function public.student_status(p_session uuid, p_student uuid) returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when now() < s.opens_at then 'not_open'
    when now() >= public.student_deadline(s.id, p_student) then 'closed'
    when now() < greatest(s.closes_at, coalesce(
           (select e.closes_at from public.deadline_extensions e where e.session_id = s.id and e.student_id = p_student),
           s.closes_at)) then 'open'
    else 'grace' end
  from public.sessions s where s.id = p_session
$$;

-- ---------------------------------------------------------------------------
-- Keys and names
-- ---------------------------------------------------------------------------
create function public.team_key_of(p_key text) returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when p_key like 't:%' then p_key
    when p_key ~ '^s:[0-9a-f-]{36}$' then
      (select 't:' || s.section || '|' || s.team from public.students s where s.id = substr(p_key, 3)::uuid)
    else null end
$$;

-- Display name of a participant key within a course.
create function public.key_display_name(p_course uuid, p_key text) returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when p_key = 'none' then '(no recipient)'
    when p_key like 't:%' then substr(p_key, position('|' in p_key) + 1)
    when p_key ~ '^s:[0-9a-f-]{36}$' then
      (select s.name from public.students s where s.id = substr(p_key, 3)::uuid and s.course_id = p_course)
    when p_key ~ '^i:[0-9a-f-]{36}$' then
      (select i.display_name from public.course_instructors i where i.id = substr(p_key, 3)::uuid and i.course_id = p_course)
    else null end
$$;

-- ---------------------------------------------------------------------------
-- Recipient resolution (section 6). Mirror of resolveRecipients() in web/src/lib/recipients.ts.
-- Returns nothing when the giver does not fit the question or the path is not available.
-- ---------------------------------------------------------------------------
create function public.question_recipients(p_question uuid, p_giver_key text)
returns table (recipient_key text, display_name text, team_key text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  q public.questions;
  v_course uuid;
  me public.students;
  ins public.course_instructors;
  v_myteam text;
begin
  select qq.* into q from public.questions qq where qq.id = p_question;
  if not found then return; end if;
  select s.course_id into v_course from public.sessions s where s.id = q.session_id;

  if q.recipient_type = 'none' then
    -- the giver must still be a valid giver
    null;
  end if;

  if q.giver_type = 'students' then
    if p_giver_key !~ '^s:[0-9a-f-]{36}$' then return; end if;
    select st.* into me from public.students st where st.id = substr(p_giver_key, 3)::uuid and st.course_id = v_course;
    if not found then return; end if;
    v_myteam := 't:' || me.section || '|' || me.team;

    case q.recipient_type
    when 'none' then
      return query select 'none'::text, '(no recipient)'::text, null::text;
    when 'self' then
      return query select 's:' || me.id::text, me.name, v_myteam;
    when 'students', 'students_excluding_self', 'own_team_members', 'own_team_members_including_self' then
      return query
        select 's:' || st.id::text, st.name, 't:' || st.section || '|' || st.team
        from public.students st
        where st.course_id = v_course
          and (q.recipient_type = 'students'
               or (q.recipient_type = 'students_excluding_self' and st.id <> me.id)
               or (q.recipient_type = 'own_team_members' and st.id <> me.id and st.section = me.section and st.team = me.team)
               or (q.recipient_type = 'own_team_members_including_self' and st.section = me.section and st.team = me.team))
        order by st.section collate "C", st.team collate "C", st.name collate "C", st.id;
    when 'teams', 'teams_excluding_self' then
      return query
        select 't:' || x.section || '|' || x.team, x.team, 't:' || x.section || '|' || x.team
        from (select distinct st.section, st.team from public.students st where st.course_id = v_course) x
        where q.recipient_type = 'teams' or not (x.section = me.section and x.team = me.team)
        order by x.section collate "C", x.team collate "C";
    when 'own_team' then
      return query select v_myteam, me.team, v_myteam;
    when 'instructors' then
      return query
        select 'i:' || i.id::text, i.display_name, null::text
        from public.course_instructors i
        where i.course_id = v_course and i.is_displayed_to_students
        order by i.display_name collate "C", i.email collate "C", i.id;
    else null;
    end case;
    return;
  end if;

  -- instructor giver
  if p_giver_key !~ '^i:[0-9a-f-]{36}$' then return; end if;
  select i.* into ins from public.course_instructors i where i.id = substr(p_giver_key, 3)::uuid and i.course_id = v_course;
  if not found then return; end if;
  case q.recipient_type
  when 'none' then
    return query select 'none'::text, '(no recipient)'::text, null::text;
  when 'self' then
    return query select 'i:' || ins.id::text, ins.display_name, null::text;
  when 'students' then
    return query
      select 's:' || st.id::text, st.name, 't:' || st.section || '|' || st.team
      from public.students st where st.course_id = v_course
      order by st.section collate "C", st.team collate "C", st.name collate "C", st.id;
  when 'teams' then
    return query
      select 't:' || x.section || '|' || x.team, x.team, 't:' || x.section || '|' || x.team
      from (select distinct st.section, st.team from public.students st where st.course_id = v_course) x
      order by x.section collate "C", x.team collate "C";
  when 'instructors' then
    return query
      select 'i:' || i.id::text, i.display_name, null::text
      from public.course_instructors i
      where i.course_id = v_course and i.is_displayed_to_students
      order by i.display_name collate "C", i.email collate "C", i.id;
  else null;
  end case;
end $$;

-- ---------------------------------------------------------------------------
-- Answer validation (section 6). Mirror of validateAnswers() in web/src/lib/validation.ts.
-- Raises one of these codes as the exception message:
--   invalid_input, not_found, not_a_recipient, duplicate_recipient, too_many_recipients,
--   invalid_answer, empty_text, not_a_choice, other_not_allowed, empty_other, duplicate_choice,
--   too_few_selected, too_many_selected, out_of_range, not_on_step, sum_mismatch,
--   negative_points, below_min_point, above_max_point, not_enough_distinct, not_all_distinct,
--   wrong_option_count, duplicate_rank, rank_out_of_range, too_few_ranked, too_many_ranked,
--   invalid_contrib_value, contrib_all_required, invalid_rubric_choice, no_rubric_answer.
-- The recipient_key of the offending row, when there is one, is in DETAIL.
-- ---------------------------------------------------------------------------
create function public.aerr(p_code text, p_key text default null) returns void
language plpgsql immutable set search_path = public, pg_temp
as $$ begin raise exception using message = p_code, detail = coalesce(p_key, ''); end $$;

create function public.check_distribution(p_values numeric[], p_total numeric, p_d jsonb, p_key text default null)
returns void
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v_min numeric := case when jb_set(p_d, 'minPoint') then (p_d ->> 'minPoint')::numeric end;
  v_max numeric := case when jb_set(p_d, 'maxPoint') then (p_d ->> 'maxPoint')::numeric end;
  v_distinct int;
begin
  if exists (select 1 from unnest(p_values) v where v < 0) then perform public.aerr('negative_points', p_key); end if;
  if v_min is not null and exists (select 1 from unnest(p_values) v where v < v_min) then perform public.aerr('below_min_point', p_key); end if;
  if v_max is not null and exists (select 1 from unnest(p_values) v where v > v_max) then perform public.aerr('above_max_point', p_key); end if;
  if (select coalesce(sum(v), 0) from unnest(p_values) v) <> p_total then perform public.aerr('sum_mismatch', p_key); end if;
  select count(distinct v) into v_distinct from unnest(p_values) v;
  if p_d ->> 'distribute' = 'some' and v_distinct < 2 then perform public.aerr('not_enough_distinct', p_key); end if;
  if p_d ->> 'distribute' = 'all' and v_distinct <> cardinality(p_values) then perform public.aerr('not_all_distinct', p_key); end if;
end $$;

create function public.check_rank_count(p_count int, p_d jsonb) returns void
language plpgsql immutable set search_path = public, pg_temp
as $$
begin
  if jb_set(p_d, 'minToRank') and p_count < (p_d ->> 'minToRank')::int then perform public.aerr('too_few_ranked'); end if;
  if jb_set(p_d, 'maxToRank') and p_count > (p_d ->> 'maxToRank')::int then perform public.aerr('too_many_ranked'); end if;
end $$;

create function public.validate_answers(p_question uuid, p_giver_key text, p_answers jsonb) returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  q public.questions;
  d jsonb;
  v_keys text[];
  v_nrec int;
  v_limit int;
  v_seen text[] := '{}';
  a jsonb;
  v jsonb;
  k text;
  v_count int;
  v_vals numeric[];
  v_total numeric;
  v_sum numeric;
  v_n int;
  v_x numeric;
  v_step numeric;
  v_kk numeric;
  v_ranked numeric[];
  v_picked text[];
  v_has_other boolean;
  v_other_ok boolean;
begin
  select * into q from public.questions where id = p_question;
  if not found then raise exception 'not_found'; end if;
  d := q.details;
  if jsonb_typeof(p_answers) is distinct from 'array' then raise exception 'invalid_input'; end if;
  if jsonb_array_length(p_answers) = 0 then return; end if;

  select array_agg(r.recipient_key), count(*) into v_keys, v_nrec from public.question_recipients(p_question, p_giver_key) r;
  v_nrec := coalesce(v_nrec, 0);
  v_keys := coalesce(v_keys, '{}');

  -- recipient checks
  for a in select value from jsonb_array_elements(p_answers) loop
    if jsonb_typeof(a) <> 'object' or jsonb_typeof(a -> 'recipient_key') is distinct from 'string' then
      raise exception 'invalid_input';
    end if;
    k := a ->> 'recipient_key';
    if not (k = any (v_keys)) then perform public.aerr('not_a_recipient', k); end if;
    if k = any (v_seen) then perform public.aerr('duplicate_recipient', k); end if;
    v_seen := v_seen || k;
    if jb_set(a, 'giver_comment') and jsonb_typeof(a -> 'giver_comment') <> 'string' then
      perform public.aerr('invalid_input', k);
    end if;
  end loop;
  v_count := jsonb_array_length(p_answers);
  if q.max_recipients is not null and v_count > q.max_recipients then raise exception 'too_many_recipients'; end if;
  v_limit := case when q.max_recipients is null then v_nrec else least(q.max_recipients, v_nrec) end;

  case q.type
  when 'text' then
    for a in select value from jsonb_array_elements(p_answers) loop
      k := a ->> 'recipient_key'; v := a -> 'answer';
      if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v -> 'text') is distinct from 'string' then
        perform public.aerr('invalid_answer', k);
      end if;
      if btrim(v ->> 'text') = '' then perform public.aerr('empty_text', k); end if;
    end loop;

  when 'mcq' then
    v_other_ok := coalesce((d ->> 'otherEnabled')::boolean, false);
    for a in select value from jsonb_array_elements(p_answers) loop
      k := a ->> 'recipient_key'; v := a -> 'answer';
      if jsonb_typeof(v) is distinct from 'object' then perform public.aerr('invalid_answer', k); end if;
      if (v ? 'choice') = (v ? 'other')
         or ((v ? 'choice') and jsonb_typeof(v -> 'choice') <> 'string')
         or ((v ? 'other') and jsonb_typeof(v -> 'other') <> 'string') then
        perform public.aerr('invalid_answer', k);
      elsif v ? 'choice' then
        if not ((v ->> 'choice') = any (jb_texts(d -> 'choices'))) then perform public.aerr('not_a_choice', k); end if;
      elsif not v_other_ok then perform public.aerr('other_not_allowed', k);
      elsif btrim(v ->> 'other') = '' then perform public.aerr('empty_other', k);
      end if;
    end loop;

  when 'msq' then
    v_other_ok := coalesce((d ->> 'otherEnabled')::boolean, false);
    for a in select value from jsonb_array_elements(p_answers) loop
      k := a ->> 'recipient_key'; v := a -> 'answer';
      if jsonb_typeof(v) is distinct from 'object' or not jb_is_str_array(v -> 'choices')
         or ((v ? 'other') and jsonb_typeof(v -> 'other') <> 'string') then
        perform public.aerr('invalid_answer', k);
      end if;
      v_picked := jb_texts(v -> 'choices');
      if exists (select 1 from unnest(v_picked) c where not (c = any (jb_texts(d -> 'choices')))) then
        perform public.aerr('not_a_choice', k);
      end if;
      if (select count(distinct c) from unnest(v_picked) c) <> cardinality(v_picked) then perform public.aerr('duplicate_choice', k); end if;
      v_has_other := v ? 'other';
      if v_has_other and not v_other_ok then perform public.aerr('other_not_allowed', k);
      elsif v_has_other and btrim(v ->> 'other') = '' then perform public.aerr('empty_other', k);
      end if;
      v_n := cardinality(v_picked) + case when v_has_other then 1 else 0 end;
      if v_n > 0 then
        if jb_set(d, 'minSelectable') and v_n < (d ->> 'minSelectable')::int then perform public.aerr('too_few_selected', k); end if;
        if jb_set(d, 'maxSelectable') and v_n > (d ->> 'maxSelectable')::int then perform public.aerr('too_many_selected', k); end if;
      end if;
    end loop;

  when 'numscale' then
    for a in select value from jsonb_array_elements(p_answers) loop
      k := a ->> 'recipient_key'; v := a -> 'answer';
      if jsonb_typeof(v) is distinct from 'object' or not jb_is_num(v -> 'value') then perform public.aerr('invalid_answer', k); end if;
      v_x := (v ->> 'value')::numeric;
      if v_x < (d ->> 'min')::numeric or v_x > (d ->> 'max')::numeric then perform public.aerr('out_of_range', k); end if;
      v_step := (d ->> 'step')::numeric;
      v_kk := floor((v_x - (d ->> 'min')::numeric) / v_step + 0.5);
      if abs(v_x - ((d ->> 'min')::numeric + v_kk * v_step)) > 1e-9 then perform public.aerr('not_on_step', k); end if;
    end loop;

  when 'constsum_options' then
    v_n := jsonb_array_length(d -> 'options');
    v_total := case when (d ->> 'pointsPerOption')::boolean then (d ->> 'points')::numeric * v_n else (d ->> 'points')::numeric end;
    for a in select value from jsonb_array_elements(p_answers) loop
      k := a ->> 'recipient_key'; v := a -> 'answer';
      if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v -> 'points') is distinct from 'array'
         or exists (select 1 from jsonb_array_elements(v -> 'points') e where not jb_is_int(e)) then
        perform public.aerr('invalid_answer', k);
      end if;
      if jsonb_array_length(v -> 'points') <> v_n then perform public.aerr('wrong_option_count', k); end if;
      perform public.check_distribution(array(select e::numeric from jsonb_array_elements_text(v -> 'points') e), v_total, d, k);
    end loop;

  when 'constsum_recipients' then
    v_vals := '{}';
    for a in select value from jsonb_array_elements(p_answers) loop
      k := a ->> 'recipient_key'; v := a -> 'answer';
      if jsonb_typeof(v) is distinct from 'object' or not jb_is_int(v -> 'points') then perform public.aerr('invalid_answer', k); end if;
      v_vals := v_vals || (v ->> 'points')::numeric;
    end loop;
    v_total := case when (d ->> 'pointsPerOption')::boolean then (d ->> 'points')::numeric * v_count else (d ->> 'points')::numeric end;
    perform public.check_distribution(v_vals, v_total, d);

  when 'contrib' then
    v_sum := 0;
    for a in select value from jsonb_array_elements(p_answers) loop
      k := a ->> 'recipient_key'; v := a -> 'answer';
      if jsonb_typeof(v) is distinct from 'object' or not jb_is_int(v -> 'value') then perform public.aerr('invalid_answer', k); end if;
      v_x := (v ->> 'value')::numeric;
      if v_x = -101 then
        if not coalesce((d ->> 'isNotSureAllowed')::boolean, false) then perform public.aerr('invalid_contrib_value', k); end if;
      elsif v_x < 0 or v_x > 200 then perform public.aerr('out_of_range', k);
      elsif v_x % 5 <> 0 then perform public.aerr('not_on_step', k);
      else v_sum := v_sum + v_x;
      end if;
    end loop;
    if coalesce((d ->> 'isZeroSum')::boolean, false) then
      if v_count <> v_nrec then raise exception 'contrib_all_required'; end if;
      if v_sum <> 100 * v_nrec then raise exception 'sum_mismatch'; end if;
    end if;

  when 'rubric' then
    for a in select value from jsonb_array_elements(p_answers) loop
      k := a ->> 'recipient_key'; v := a -> 'answer';
      if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v -> 'choices') is distinct from 'array'
         or jsonb_array_length(v -> 'choices') <> jsonb_array_length(d -> 'subQuestions') then
        perform public.aerr('invalid_answer', k);
      end if;
      if exists (select 1 from jsonb_array_elements(v -> 'choices') c
                 where not jb_is_int(c)
                    or not ((c #>> '{}')::numeric = -1 or ((c #>> '{}')::numeric >= 0 and (c #>> '{}')::numeric < jsonb_array_length(d -> 'choices')))) then
        perform public.aerr('invalid_rubric_choice', k);
      end if;
      if not exists (select 1 from jsonb_array_elements(v -> 'choices') c where (c #>> '{}')::numeric <> -1) then
        perform public.aerr('no_rubric_answer', k);
      end if;
    end loop;

  when 'rank_options' then
    v_n := jsonb_array_length(d -> 'options');
    for a in select value from jsonb_array_elements(p_answers) loop
      k := a ->> 'recipient_key'; v := a -> 'answer';
      if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v -> 'ranks') is distinct from 'array'
         or jsonb_array_length(v -> 'ranks') <> v_n
         or exists (select 1 from jsonb_array_elements(v -> 'ranks') r where jsonb_typeof(r) <> 'null' and not jb_is_int(r)) then
        perform public.aerr('invalid_answer', k);
      end if;
      v_ranked := array(select (r #>> '{}')::numeric from jsonb_array_elements(v -> 'ranks') r where jsonb_typeof(r) <> 'null');
      if exists (select 1 from unnest(v_ranked) r where r < 1 or r > v_n) then perform public.aerr('rank_out_of_range', k); end if;
      if not coalesce((d ->> 'duplicatesAllowed')::boolean, false)
         and (select count(distinct r) from unnest(v_ranked) r) <> cardinality(v_ranked) then
        perform public.aerr('duplicate_rank', k);
      end if;
      if cardinality(v_ranked) = 0 then perform public.aerr('too_few_ranked', k); end if;
      begin
        perform public.check_rank_count(cardinality(v_ranked), d);
      exception when others then
        perform public.aerr(sqlerrm, k);
      end;
    end loop;

  when 'rank_recipients' then
    v_vals := '{}';
    for a in select value from jsonb_array_elements(p_answers) loop
      k := a ->> 'recipient_key'; v := a -> 'answer';
      if jsonb_typeof(v) is distinct from 'object' or not jb_is_int(v -> 'rank') then perform public.aerr('invalid_answer', k); end if;
      v_x := (v ->> 'rank')::numeric;
      if v_x < 1 or v_x > v_limit then perform public.aerr('rank_out_of_range', k); end if;
      v_vals := v_vals || v_x;
    end loop;
    if not coalesce((d ->> 'duplicatesAllowed')::boolean, false)
       and (select count(distinct r) from unnest(v_vals) r) <> cardinality(v_vals) then
      raise exception 'duplicate_rank';
    end if;
    perform public.check_rank_count(cardinality(v_vals), d);

  else
    raise exception 'invalid_type';
  end case;
end $$;

-- ---------------------------------------------------------------------------
-- Student visibility (section 7)
-- ---------------------------------------------------------------------------
-- Does the viewer qualify for at least one entry of a visibility list?
create function public.viewer_qualifies(p_list text[], p_viewer public.students, p_giver text, p_recipient text)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_team text := 't:' || p_viewer.section || '|' || p_viewer.team;
begin
  if 'students' = any (p_list) then return true; end if;
  if 'recipient' = any (p_list) and (p_recipient = 's:' || p_viewer.id::text or p_recipient = v_team) then return true; end if;
  if 'giver_team_members' = any (p_list) and public.team_key_of(p_giver) = v_team then return true; end if;
  if 'recipient_team_members' = any (p_list) and public.team_key_of(p_recipient) = v_team then return true; end if;
  return false;
end $$;

-- can_view for a student viewer, on raw keys. A giver always sees their own response with full names;
-- the recipient (or the recipient's team) always sees the recipient name when seeing the response.
create function public.can_view_keys(p_question public.questions, p_giver text, p_recipient text, p_viewer public.students)
returns table (sees_response boolean, sees_giver_name boolean, sees_recipient_name boolean)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_own boolean := p_giver = 's:' || p_viewer.id::text;
  v_resp boolean;
begin
  if v_own then
    return query select true, true, true; return;
  end if;
  v_resp := public.viewer_qualifies(p_question.show_responses_to, p_viewer, p_giver, p_recipient);
  if not v_resp then
    return query select false, false, false; return;
  end if;
  return query select true,
    public.viewer_qualifies(p_question.show_giver_name_to, p_viewer, p_giver, p_recipient),
    public.viewer_qualifies(p_question.show_recipient_name_to, p_viewer, p_giver, p_recipient)
      or p_recipient = 's:' || p_viewer.id::text
      or p_recipient = 't:' || p_viewer.section || '|' || p_viewer.team;
end $$;

create function public.can_view(p_question uuid, p_response uuid, p_viewer uuid)
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
  return query select * from public.can_view_keys(q, r.giver_key, r.recipient_key, vs);
end $$;

-- ---------------------------------------------------------------------------
-- Contribution calculation (section 9): exact port of TeamEvalResult.java.
-- Sentinels: NA = -9999, NSU = -101, NSB = -999. Matrices are jsonb arrays of arrays.
-- ---------------------------------------------------------------------------
create function public.contrib_row(j jsonb) returns float8[]
language sql immutable set search_path = public, pg_temp
as $$ select coalesce(array(select e::float8 from jsonb_array_elements_text(j) with ordinality t(e, o) order by o), '{}'::float8[]) $$;

create function public.contrib_is_special(v float8) returns boolean
language sql immutable set search_path = public, pg_temp
as $$ select trunc(v) in (-9999::float8, -101::float8, -999::float8) $$;

-- Java Math.round cast to int: floor(x + 0.5); NaN is 0; +Infinity wraps to -1; -Infinity to 0.
create function public.contrib_round(v float8) returns int
language sql immutable set search_path = public, pg_temp
as $$
  select case
    when v = 'NaN'::float8 then 0
    when v = 'Infinity'::float8 then -1
    when v = '-Infinity'::float8 then 0
    else floor(v + 0.5)::int end
$$;

create function public.contrib_round_row(a float8[]) returns int[]
language sql immutable set search_path = public, pg_temp
as $$ select coalesce(array(select public.contrib_round(e) from unnest(a) with ordinality t(e, o) order by o), '{}'::int[]) $$;

-- Division as Java does it for doubles (no error on zero).
create function public.contrib_div(n float8, d float8) returns float8
language sql immutable set search_path = public, pg_temp
as $$
  select case when d = 0 then (case when n > 0 then 'Infinity'::float8 when n < 0 then '-Infinity'::float8 else 'NaN'::float8 end)
              else n / d end
$$;

create function public.contrib_factor(a float8[]) returns float8
language sql immutable set search_path = public, pg_temp
as $$
  select case when coalesce(sum(e) filter (where not public.contrib_is_special(e)), 0) = 0 then 0
              else (count(*) filter (where not public.contrib_is_special(e)))::float8 * 100
                   / sum(e) filter (where not public.contrib_is_special(e)) end
  from unnest(a) e
$$;

create function public.contrib_mult(p_factor float8, a float8[]) returns float8[]
language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(array(
    select case when public.contrib_is_special(e) then e when p_factor = 0 then e else e * p_factor end
    from unnest(a) with ordinality t(e, o) order by o), '{}'::float8[])
$$;

create function public.contrib_normalize(a float8[]) returns float8[]
language sql immutable set search_path = public, pg_temp
as $$ select public.contrib_mult(public.contrib_factor(a), a) $$;

create function public.contrib_remove_self(m jsonb) returns jsonb
language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(
    (select jsonb_agg(case when (r.i - 1) = (c.j - 1) then to_jsonb(-9999) else c.e end order by c.j)
     from jsonb_array_elements(r.row) with ordinality c(e, j))
    order by r.i), '[]'::jsonb)
  from jsonb_array_elements(m) with ordinality r(row, i)
$$;

-- Column averages skipping NA and NSU; NA when nothing is left. Reads column i for each row i.
create function public.contrib_average_columns(m jsonb) returns float8[]
language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(array(
    select coalesce((select avg(e::float8) from jsonb_array_elements(m) r(row),
                          lateral (select (r.row ->> (g.i - 1)) as e) x
                     where e::float8 <> -9999 and e::float8 <> -101), -9999)
    from generate_series(1, jsonb_array_length(m)) g(i) order by g.i), '{}'::float8[])
$$;

create function public.contrib_is_sanitized(a float8[]) returns boolean
language sql immutable set search_path = public, pg_temp
as $$ select not exists (select 1 from unnest(a) e where e = -999) $$;

-- sum(): NA when nothing but NA/NSU values, 0 for an empty array.
create function public.contrib_sum(a float8[]) returns float8
language plpgsql immutable set search_path = public, pg_temp
as $$
declare s float8 := -9999; e float8;
begin
  if cardinality(a) = 0 then return 0; end if;
  foreach e in array a loop
    if not (e = -9999 or e = -101) then
      s := case when s = -9999 then e else s + e end;
    end if;
  end loop;
  return s;
end $$;

create function public.contrib_purge(p_filter float8[], p_values float8[]) returns float8[]
language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(array(
    select case when trunc(f.e) in (-9999::float8, -101::float8, -999::float8) then (case when trunc(f.e) = -101 then -101::float8 else -9999::float8 end)
                else p_values[f.o] end
    from unnest(p_filter) with ordinality f(e, o) order by f.o), '{}'::float8[])
$$;

create function public.contrib_perceived_for_student(p_claimed float8[], p_avg float8[]) returns int[]
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  v_perceived float8[] := public.contrib_purge(p_claimed, p_avg);
  v_actual float8[] := array(select public.contrib_round(e) from unnest(public.contrib_purge(p_avg, p_claimed)) with ordinality t(e, o) order by o);
  v_sum_p float8 := public.contrib_sum(v_perceived);
  v_sum_a float8 := trunc(public.contrib_sum(v_actual));
begin
  if v_sum_a = -9999 then v_sum_a := v_sum_p; end if;
  return public.contrib_round_row(public.contrib_mult(public.contrib_div(v_sum_a, v_sum_p), p_avg));
end $$;

-- p_claimed: n x n integer matrix (rows are givers, columns recipients). Returns the four result matrices.
create function public.contrib_calc(p_claimed jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  n int := jsonb_array_length(p_claimed);
  v_norm_claimed jsonb := '[]';
  v_sanitized jsonb := '[]';
  v_sn jsonb := '[]';
  v_peer jsonb;
  v_peer_adj jsonb := '[]';
  v_row float8[];
  v_avg float8[];
  v_nap float8[];
  v_factor float8;
  v_denorm jsonb := '[]';
  r jsonb;
begin
  if n = 0 then
    return jsonb_build_object('normalizedClaimed', '[]', 'normalizedPeerContributionRatio', '[]',
                              'normalizedAveragePerceived', '[]', 'denormalizedAveragePerceived', '[]');
  end if;
  for r in select value from jsonb_array_elements(p_claimed) loop
    v_row := public.contrib_row(r);
    v_norm_claimed := v_norm_claimed || jsonb_build_array(to_jsonb(public.contrib_round_row(public.contrib_normalize(v_row))));
    v_row := array(select case when e = -999 then -9999::float8 else e end from unnest(v_row) with ordinality t(e, o) order by o);
    v_sanitized := v_sanitized || jsonb_build_array(to_jsonb(v_row));
    v_sn := v_sn || jsonb_build_array(to_jsonb(public.contrib_normalize(v_row)));
  end loop;
  -- peer ratio: remove self ratings, then normalize each row
  v_peer := '[]';
  for r in select value from jsonb_array_elements(public.contrib_remove_self(v_sn)) loop
    v_peer := v_peer || jsonb_build_array(to_jsonb(public.contrib_normalize(public.contrib_row(r))));
  end loop;
  v_avg := public.contrib_average_columns(v_peer);
  v_nap := public.contrib_normalize(v_avg);
  v_factor := public.contrib_factor(public.contrib_average_columns(v_peer));
  for r in select value from jsonb_array_elements(v_peer) loop
    v_peer_adj := v_peer_adj || jsonb_build_array(to_jsonb(public.contrib_round_row(public.contrib_mult(v_factor, public.contrib_row(r)))));
  end loop;
  for r in select value from jsonb_array_elements(v_sanitized) loop
    v_denorm := v_denorm || jsonb_build_array(to_jsonb(public.contrib_perceived_for_student(public.contrib_row(r), v_nap)));
  end loop;
  return jsonb_build_object(
    'normalizedClaimed', v_norm_claimed,
    'normalizedPeerContributionRatio', v_peer_adj,
    'normalizedAveragePerceived', to_jsonb(public.contrib_round_row(v_nap)),
    'denormalizedAveragePerceived', v_denorm);
end $$;

-- Results for one team of a contrib question. Members are the team's students in roster order
-- (name, then id). Responses whose giver or recipient is outside the team are ignored; a missing
-- response is NSB (-999).
create function public.contrib_team_result(p_question uuid, p_team_key text) returns jsonb
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
      select (r.answer ->> 'value')::int into v_val from public.responses r
       where r.question_id = p_question and r.giver_key = 's:' || v_ids[i]::text and r.recipient_key = 's:' || v_ids[j]::text;
      v_row := v_row || to_jsonb(coalesce(v_val, -999));
      v_val := null;
    end loop;
    v_matrix := v_matrix || jsonb_build_array(v_row);
  end loop;

  return jsonb_build_object('team_key', p_team_key, 'members', v_members, 'claimed', v_matrix)
         || public.contrib_calc(v_matrix);
end $$;
