-- enroll_students and the roster triggers.
begin;
\ir seed.sql

create function t.enr(p_rows jsonb) returns jsonb language sql as $$ select public.enroll_students(t.id('A'), p_rows) $$;
create function t.codes(p jsonb) returns text language sql as $$
  select coalesce(string_agg((e ->> 'row') || ':' || (e ->> 'code'), ','), '') from jsonb_array_elements(p -> 'errors') e $$;

select t.as_user(t.id('owner'), 'owner@a.edu');
do $$
declare r jsonb; n0 int := (select count(*) from public.students);
begin
  r := t.enr('[{"section":"S9","team":"T9","name":"New One","email":" New.One@S.edu ","comments":"hi"},
               {"name":"No Defaults","email":"nd@s.edu"}]');
  perform t.eq(r ->> 'created', '2', 'creates two');
  perform t.eq(r ->> 'updated', '0', 'updates none');
  perform t.is_true((select section = 'S9' and email = 'new.one@s.edu' and comments = 'hi' from public.students where name = 'New One'), 'trims and lowercases email');
  perform t.is_true((select section = 'Default Section' and team = 'Default Team' from public.students where name = 'No Defaults'), 'blank section and team get defaults');
  perform t.is_true((select length(access_token) >= 40 from public.students where name = 'New One'), 'new student has an access token');

  -- upsert by email, keeps the token, clears comments
  declare tok text := (select access_token from public.students where email = 'new.one@s.edu');
  begin
    r := t.enr('[{"section":"S9","team":"T10","name":"Renamed","email":"NEW.ONE@s.edu"}]');
    perform t.eq(r ->> 'updated', '1', 'existing email is updated');
    perform t.eq(r ->> 'created', '0', 'and not created');
    perform t.is_true((select team = 'T10' and name = 'Renamed' and comments is null and access_token = tok from public.students where email = 'new.one@s.edu'), 'update changes fields, clears comments, keeps token');
  end;
  perform t.eq((select count(*)::text from public.students), (n0 + 2)::text, 'row count after upserts');

  -- errors (all or nothing)
  r := t.enr('[{"name":"Ok","email":"ok@s.edu"},{"name":"","email":"x@s.edu"}]');
  perform t.eq(t.codes(r), '2:required_field_missing', 'missing name');
  perform t.eq(r ->> 'created', '0', 'nothing created when a row is bad');
  perform t.eq((select count(*)::text from public.students where email = 'ok@s.edu'), '0', 'all or nothing: the good row was not written');
  perform t.eq(t.codes(t.enr('[{"name":"A","email":""}]')), '1:required_field_missing', 'missing email');
  perform t.eq(t.codes(t.enr('[{"name":"A|B","email":"a@s.edu"}]')), '1:forbidden_char', 'pipe in name');
  perform t.eq(t.codes(t.enr('[{"name":"A","team":"50%","email":"a@s.edu"}]')), '1:forbidden_char', 'percent in team');
  perform t.eq(t.codes(t.enr('[{"name":"A","section":"S|1","email":"a@s.edu"}]')), '1:forbidden_char', 'pipe in section');
  perform t.eq(t.codes(t.enr(jsonb_build_array(jsonb_build_object('name', repeat('x', 101), 'email', 'a@s.edu')))), '1:too_long', 'name too long');
  perform t.eq(t.codes(t.enr(jsonb_build_array(jsonb_build_object('name', 'A', 'team', repeat('x', 61), 'email', 'a@s.edu')))), '1:too_long', 'team too long');
  perform t.eq(t.codes(t.enr(jsonb_build_array(jsonb_build_object('name', 'A', 'email', 'a@s.edu', 'comments', repeat('x', 501))))), '1:too_long', 'comments too long');
  perform t.eq(t.codes(t.enr(jsonb_build_array(jsonb_build_object('name', 'A', 'email', repeat('x', 250) || '@s.edu')))), '1:too_long', 'email too long');
  perform t.eq(t.codes(t.enr('[{"name":"A","email":"not-an-email"}]')), '1:invalid_email', 'invalid email');
  perform t.eq(t.codes(t.enr('[{"name":"A","email":"a b@s.edu"}]')), '1:invalid_email', 'email with a space');
  perform t.eq(t.codes(t.enr('[{"name":"A","team":"x@y.com","email":"a@s.edu"}]')), '1:team_looks_like_email', 'team that looks like an email');
  perform t.eq(t.codes(t.enr('[{"name":"A","email":"dup@s.edu"},{"name":"B","email":"DUP@s.edu"},{"name":"C","email":"c@s.edu"}]')), '2:duplicate_email', 'duplicate email in one submission');
  perform t.eq(t.codes(t.enr('["x", {"name":"A","email":"a@s.edu"}]')), '1:invalid_input', 'row that is not an object');
  perform t.eq(t.codes(t.enr('[{"name":"A"},{"email":"b@s.edu"}]')), '1:required_field_missing,2:required_field_missing', 'several errors are all reported');
  perform t.throws($q$select public.enroll_students(t.id('A'), '{"a":1}')$q$, 'invalid_input', 'rows must be an array');
  perform t.eq(t.enr('[]') ->> 'created', '0', 'empty list is fine');

  -- section size limit: S2 has 5 students (Frank, Gina, Hal, Ivy, Jon)
  r := t.enr((select jsonb_agg(jsonb_build_object('section', 'S2', 'name', 'Bulk ' || g, 'email', 'bulk' || g || '@s.edu')) from generate_series(1, 96) g));
  perform t.eq(r ->> 'created', '0', 'section over 100: nothing created');
  perform t.is_true(t.codes(r) like '1:section_too_large%' and jsonb_array_length(r -> 'errors') = 96, 'section over 100: every incoming row of that section flagged');
  r := t.enr((select jsonb_agg(jsonb_build_object('section', 'S2', 'name', 'Bulk ' || g, 'email', 'bulk' || g || '@s.edu')) from generate_series(1, 95) g));
  perform t.eq(r ->> 'created', '95', 'section at exactly 100 is allowed');
  -- re-uploading the same full section does not trip the limit
  r := t.enr((select jsonb_agg(jsonb_build_object('section', 'S2', 'name', 'Bulk ' || g, 'email', 'bulk' || g || '@s.edu')) from generate_series(1, 95) g));
  perform t.eq(r ->> 'updated', '95', 're-upload of a full section updates in place');
  perform t.throws($q$insert into public.students (course_id, section, name, email) values (t.id('A'), 'S2', 'One Too Many', 'toomany@s.edu')$q$, 'section_too_large', 'direct insert into a full section');
end $$;

-- direct writes go through the same field validation
select t.throws($$insert into public.students (course_id, name, email) values (t.id('A'), 'x|y', 'a@s.edu')$$, 'forbidden_char', 'direct insert: pipe in name');
select t.throws($$insert into public.students (course_id, name, email) values (t.id('A'), 'x', 'bad')$$, 'invalid_email', 'direct insert: bad email');
select t.throws($$update public.students set email = 'bob@s.edu' where name = 'Carol'$$, '23505', 'direct update: duplicate email');
select t.lives($$update public.students set team = 'T1x' where name = 'Carol'$$, 'direct update: change team');
select t.reset();
rollback;
