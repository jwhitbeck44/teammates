-- Session rules: published state, deadlines with grace and extensions, portal status,
-- publish and unpublish, copy, validation.
begin;
\ir seed.sql
create function t.pub(p uuid) returns boolean language sql security definer as $$ select public.session_is_published(p) $$;
grant execute on function t.pub(uuid) to public;

do $$
declare
  s uuid; q uuid; tk text := t.tok('Alice'); r jsonb; me uuid := t.id('Alice');
begin
  -- ---------- session_is_published ----------
  s := t.mk_session('later', interval '-1 day', interval '1 day', 15, 'later');
  perform t.is_true(not public.session_is_published(s), 'later: not published');
  s := t.mk_session('at_open open', interval '-1 hour', interval '1 day', 15, 'at_open');
  perform t.is_true(public.session_is_published(s), 'at_open after opening: published');
  s := t.mk_session('at_open future', interval '1 hour', interval '1 day', 15, 'at_open');
  perform t.is_true(not public.session_is_published(s), 'at_open before opening: not published');
  insert into public.sessions (course_id, name, opens_at, closes_at, results_visibility, results_visible_at)
  values (t.id('A'), 'custom past', now() - interval '2 days', now() - interval '1 day', 'custom', now() - interval '1 hour') returning id into s;
  perform t.is_true(public.session_is_published(s), 'custom: visible time reached');
  insert into public.sessions (course_id, name, opens_at, closes_at, results_visibility, results_visible_at)
  values (t.id('A'), 'custom future', now() - interval '2 days', now() - interval '1 day', 'custom', now() + interval '1 hour') returning id into s;
  perform t.is_true(not public.session_is_published(s), 'custom: visible time not reached');
  s := t.mk_session('manual', interval '-1 day', interval '1 day');
  update public.sessions set published_at = now() where id = s;
  perform t.is_true(public.session_is_published(s), 'manual published_at: published');
  perform t.is_true(not public.session_is_published(gen_random_uuid()), 'unknown session: not published');
end $$;

-- ---------- deadlines ----------
do $$
declare
  s_open uuid := t.mk_session('d-open', interval '-1 day', interval '1 day', 15);
  s_grace uuid := t.mk_session('d-grace', interval '-1 day', interval '-10 minutes', 15);
  s_closed uuid := t.mk_session('d-closed', interval '-1 day', interval '-20 minutes', 15);
  s_future uuid := t.mk_session('d-future', interval '1 hour', interval '2 days', 15);
  s_nograce uuid := t.mk_session('d-nograce', interval '-1 day', interval '-1 minute', 0);
  tk text := t.tok('Alice'); me uuid := t.id('Alice'); bob uuid := t.id('Bob');
  q uuid; a jsonb := jsonb_build_array(t.row(t.sk('Bob'), '{"text":"hi"}'));
  ss uuid[] := array[s_open, s_grace, s_closed, s_future, s_nograce];
  x uuid;
begin
  foreach x in array ss loop perform t.mk_q(x, 1, 'text', 'own_team_members'); end loop;
  select id into q from public.questions where session_id = s_open;

  perform t.eq(public.student_status(s_open, me), 'open', 'status: open');
  perform t.eq(public.student_status(s_grace, me), 'grace', 'status: grace');
  perform t.eq(public.student_status(s_closed, me), 'closed', 'status: closed');
  perform t.eq(public.student_status(s_future, me), 'not_open', 'status: not open');
  perform t.eq(public.student_status(s_nograce, me), 'closed', 'status: closed right at close with zero grace');
  perform t.is_true(public.student_deadline(s_grace, me) = (select closes_at + interval '15 minutes' from public.sessions where id = s_grace), 'deadline = closes_at + grace');

  perform t.lives(format('select public.student_submit(%L, %L, %L, %L)', tk, s_open, q, a), 'submit while open');
  select id into q from public.questions where session_id = s_grace;
  perform t.lives(format('select public.student_submit(%L, %L, %L, %L)', tk, s_grace, q, a), 'submit during grace');
  select id into q from public.questions where session_id = s_closed;
  perform t.throws(format('select public.student_submit(%L, %L, %L, %L)', tk, s_closed, q, a), 'deadline_passed', 'submit after grace');
  select id into q from public.questions where session_id = s_nograce;
  perform t.throws(format('select public.student_submit(%L, %L, %L, %L)', tk, s_nograce, q, a), 'deadline_passed', 'submit after close with zero grace');
  select id into q from public.questions where session_id = s_future;
  perform t.throws(format('select public.student_submit(%L, %L, %L, %L)', tk, s_future, q, a), 'not_open_yet', 'submit before opening');
  perform t.throws(format('select public.student_get_session(%L, %L)', tk, s_future), 'not_open_yet', 'get_session before opening');
  perform t.lives(format('select public.student_get_session(%L, %L)', tk, s_closed), 'get_session after close still readable');

  -- extensions (superuser here; the trigger still validates)
  perform t.throws(format('insert into public.deadline_extensions values (%L, %L, now() - interval ''30 minutes'')', s_closed, me), 'invalid_extension', 'extension must be after closes_at');
  perform t.throws(format('insert into public.deadline_extensions values (%L, %L, now() + interval ''1 hour'')', s_closed, t.id('Zed')), 'not_found', 'extension for a student of another course');
  insert into public.deadline_extensions values (s_closed, me, now() + interval '1 hour');
  perform t.eq(public.student_status(s_closed, me), 'open', 'extension: open again');
  perform t.is_true(public.student_deadline(s_closed, me) > now() + interval '55 minutes', 'extension: deadline is the extension');
  perform t.lives(format('select public.student_submit(%L, %L, %L, %L)', tk, s_closed,
                         (select id from public.questions where session_id = s_closed), a), 'submit with extension');
  perform t.throws(format('select public.student_submit(%L, %L, %L, %L)', t.tok('Bob'), s_closed,
                         (select id from public.questions where session_id = s_closed), jsonb_build_array(t.row(t.sk('Alice'), '{"text":"hi"}'))), 'deadline_passed', 'extension is per student');
  -- extension shorter than closes_at + grace: TEAMMATES rule keeps the longer of the two
  insert into public.deadline_extensions values (s_grace, me, now() - interval '5 minutes' + interval '1 minute');
  perform t.is_true(public.student_deadline(s_grace, me) = (select closes_at + interval '15 minutes' from public.sessions where id = s_grace),
                    'extension shorter than grace: deadline stays closes_at + grace (greatest rule)');
  update public.deadline_extensions set closes_at = now() - interval '1 minute' where session_id = s_grace;
  update public.deadline_extensions set closes_at = now() + interval '3 hours' where session_id = s_grace;
  perform t.is_true(public.student_deadline(s_grace, me) > now() + interval '2 hours', 'extension longer than grace wins');
  perform t.eq(public.student_status(s_grace, me), 'open', 'extension: status open');

  -- portal
  perform t.eq((select count(*)::text from jsonb_array_elements(public.student_portal(tk) -> 'sessions')), '9', 'portal lists the 9 opened sessions, not the 2 future ones');
  perform t.eq((select e ->> 'status' from jsonb_array_elements(public.student_portal(tk) -> 'sessions') e where e ->> 'name' = 'd-grace'), 'open', 'portal: status for extended student');
  perform t.eq((select e ->> 'status' from jsonb_array_elements(public.student_portal(t.tok('Bob')) -> 'sessions') e where e ->> 'name' = 'd-grace'), 'grace', 'portal: status for other student in grace');
  perform t.eq((select e ->> 'submitted' from jsonb_array_elements(public.student_portal(tk) -> 'sessions') e where e ->> 'name' = 'd-open'), 'true', 'portal: submitted flag true');
  perform t.eq((select e ->> 'submitted' from jsonb_array_elements(public.student_portal(t.tok('Bob')) -> 'sessions') e where e ->> 'name' = 'd-open'), 'false', 'portal: submitted flag false');
  perform t.eq((select e ->> 'published' from jsonb_array_elements(public.student_portal(tk) -> 'sessions') e where e ->> 'name' = 'd-open'), 'false', 'portal: published flag');
end $$;

-- ---------- publish and unpublish ----------
do $$
declare
  s uuid := t.mk_session('pub', interval '-1 day', interval '1 day');
  s_fut uuid := t.mk_session('pub-future', interval '1 day', interval '2 days');
  s_open uuid := t.mk_session('pub-atopen', interval '-1 day', interval '1 day', 15, 'at_open');
begin
  perform t.as_user(t.id('owner'), 'owner@a.edu');
  perform t.throws(format('select public.unpublish_session(%L)', s), 'not_published', 'unpublish: not published');
  perform t.throws(format('select public.publish_session(%L)', s_fut), 'not_open_yet', 'publish: not open yet');
  perform t.is_true((public.publish_session(s) ->> 'published')::boolean, 'publish works');
  perform t.is_true(t.pub(s), 'session is published');
  perform t.throws(format('select public.publish_session(%L)', s), 'already_published', 'publish twice');
  perform t.reset();
  update public.sessions set published_email_sent_at = now() where id = s;
  perform t.as_user(t.id('owner'), 'owner@a.edu');
  perform t.is_true(not (public.unpublish_session(s) ->> 'published')::boolean, 'unpublish works');
  perform t.reset();
  perform t.is_true((select published_at is null and results_visibility = 'later' and published_email_sent_at is null from public.sessions where id = s),
                    'unpublish: published_at null, visibility later, email stamp cleared');
  perform t.as_user(t.id('owner'), 'owner@a.edu');
  perform t.throws(format('select public.publish_session(%L)', s_open), 'already_published', 'at_open session counts as published');
  perform t.lives(format('select public.unpublish_session(%L)', s_open), 'unpublish an at_open session');
  perform t.reset();
  perform t.eq((select results_visibility from public.sessions where id = s_open), 'later', 'at_open becomes later after unpublish');
  perform t.as_user(t.id('owner'), 'owner@a.edu');
  perform t.lives(format('select public.publish_session(%L)', s_open), 'publish again after unpublish');
  perform t.reset();
end $$;

-- ---------- copy_session ----------
do $$
declare
  s uuid := t.mk_session('orig', interval '-1 day', interval '1 day', 20, 'later');
  c uuid; r jsonb;
begin
  perform t.mk_q(s, 1, 'mcq', 'self', '{"choices":["a","b"],"otherEnabled":false}', 'students', array['recipient','instructors'], array['instructors'], array['recipient','instructors']);
  perform t.mk_q(s, 2, 'text', 'students', '{}', 'instructors');
  update public.sessions set opened_email_sent_at = now(), closing_email_sent_at = now(), published_email_sent_at = now(),
         published_at = now(), instructions = 'read me', closing_email_enabled = false where id = s;
  perform t.as_user(t.id('owner'), 'owner@a.edu');
  r := public.copy_session(s, 'copy of orig');
  perform t.reset();
  c := (r ->> 'session_id')::uuid;
  perform t.is_true((select name = 'copy of orig' and grace_minutes = 20 and instructions = 'read me' and not closing_email_enabled
                     and opens_at = (select opens_at from public.sessions where id = s) and closes_at = (select closes_at from public.sessions where id = s)
                     from public.sessions where id = c), 'copy keeps settings and times');
  perform t.is_true((select published_at is null and opened_email_sent_at is null and closing_email_sent_at is null and published_email_sent_at is null
                     from public.sessions where id = c), 'copy clears published and email stamps');
  perform t.eq((select count(*)::text from public.questions where session_id = c), '2', 'copy has both questions');
  perform t.is_true((select q.details = o.details and q.show_responses_to = o.show_responses_to and q.show_giver_name_to = o.show_giver_name_to
                     from public.questions q join public.questions o on o.number = q.number and o.session_id = s where q.session_id = c and q.number = 1), 'copy keeps question details and visibility');
  perform t.eq((select count(*)::text from public.responses where session_id = c), '0', 'copy has no responses');
  perform t.as_user(t.id('owner'), 'owner@a.edu');
  perform t.throws(format('select public.copy_session(%L, %L)', s, 'copy of orig'), 'name_taken', 'copy with an existing name');
  perform t.reset();
  -- into another course the caller owns
  insert into public.courses (id, code, name, created_by) values ('10000000-0000-0000-0000-0000000000c1', 'C', 'Course C', t.id('owner'));
  perform t.as_user(t.id('owner'), 'owner@a.edu');
  r := public.copy_session(s, 'orig', '10000000-0000-0000-0000-0000000000c1');
  perform t.reset();
  perform t.eq((select course_id::text from public.sessions where id = (r ->> 'session_id')::uuid), '10000000-0000-0000-0000-0000000000c1', 'copy into another owned course');
end $$;

-- ---------- session validation ----------
select t.as_user(t.id('owner'), 'owner@a.edu');
select t.throws($$insert into public.sessions (course_id, name, opens_at, closes_at) values (t.id('A'), 'v1', now(), now() - interval '1 hour')$$, 'invalid_time_range', 'close before open');
select t.throws($$insert into public.sessions (course_id, name, opens_at, closes_at, grace_minutes) values (t.id('A'), 'v2', now(), now() + interval '1 hour', 7)$$, 'invalid_grace', 'grace not a multiple of 5');
select t.throws($$insert into public.sessions (course_id, name, opens_at, closes_at, grace_minutes) values (t.id('A'), 'v3', now(), now() + interval '1 hour', 35)$$, 'invalid_grace', 'grace above 30');
select t.throws($$insert into public.sessions (course_id, name, opens_at, closes_at) values (t.id('A'), 'a|b', now(), now() + interval '1 hour')$$, 'forbidden_char', 'session name with |');
select t.throws($$insert into public.sessions (course_id, name, opens_at, closes_at) values (t.id('A'), '  ', now(), now() + interval '1 hour')$$, 'required_field_missing', 'blank session name');
select t.throws($$insert into public.sessions (course_id, name, opens_at, closes_at, results_visibility) values (t.id('A'), 'v4', now(), now() + interval '1 hour', 'custom')$$, 'invalid_time_range', 'custom visibility needs a time');
select t.throws($$insert into public.sessions (course_id, name, opens_at, closes_at) values (t.id('A'), 'manual', now(), now() + interval '1 hour')$$, '23505', 'session names are unique per course');
select t.lives($$insert into public.sessions (course_id, name, opens_at, closes_at) values (t.id('A'), 'fine', now(), now() + interval '1 hour')$$, 'a valid session inserts');
select t.reset();
rollback;
