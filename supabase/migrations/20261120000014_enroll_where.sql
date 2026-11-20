-- enroll_students: the is_new update had no WHERE clause. Supabase loads pg-safeupdate for API
-- requests, which rejects UPDATE and DELETE without WHERE ("UPDATE requires a WHERE clause"), so
-- every enrolment from the website failed. The local test cluster does not load safeupdate.
-- Same function as 20261116000005_instructor_rpcs.sql except "where true" on that statement.
-- create or replace keeps the owner and the grants from 20261116000006_grants.sql.

create or replace function public.enroll_students(p_course uuid, p_rows jsonb) returns jsonb
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
    select 1 from public.students s where s.course_id = p_course and s.email = i.email)
   where true;
  select count(*) filter (where is_new), count(*) filter (where not is_new) into v_created, v_updated from _enroll_in;

  insert into public.students (course_id, section, team, name, email, comments)
  select p_course, i.section, i.team, i.name, i.email, i.comments from _enroll_in i order by i.ord
  on conflict (course_id, email) do update
    set section = excluded.section, team = excluded.team, name = excluded.name, comments = excluded.comments;

  return jsonb_build_object('created', v_created, 'updated', v_updated, 'errors', '[]'::jsonb);
end $$;
