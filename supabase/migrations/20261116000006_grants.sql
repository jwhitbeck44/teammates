-- Grants (ARCHITECTURE.md section 4). Runs after every function exists.
--  * anon: no table privileges; may execute only student_* functions.
--  * authenticated: table privileges that RLS then limits; column grants keep server-managed
--    columns (tokens, user_id, publish and email stamps) out of direct client writes.
--  * Every function starts with no execute for public; the RPCs are granted one by one.

-- Future objects: no automatic execute for public or anon.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon;

-- Tables
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;

grant select on public.courses, public.course_instructors, public.students, public.sessions,
                public.questions, public.responses, public.deadline_extensions, public.email_log
  to authenticated;
grant delete on public.courses, public.course_instructors, public.students, public.sessions,
                public.questions, public.deadline_extensions to authenticated;

grant insert (code, name, institute, time_zone), update (code, name, institute, time_zone, archived_at)
  on public.courses to authenticated;
grant insert (course_id, email, display_name, role, is_displayed_to_students),
      update (display_name, role, is_displayed_to_students)
  on public.course_instructors to authenticated;
grant insert (course_id, section, team, name, email, comments),
      update (section, team, name, email, comments)
  on public.students to authenticated;
grant insert (course_id, name, instructions, opens_at, closes_at, grace_minutes, results_visibility,
              results_visible_at, closing_email_enabled, published_email_enabled),
      update (name, instructions, opens_at, closes_at, grace_minutes, results_visibility,
              results_visible_at, closing_email_enabled, published_email_enabled)
  on public.sessions to authenticated;
grant insert (session_id, number, type, brief, description, details, giver_type, recipient_type,
              max_recipients, show_responses_to, show_giver_name_to, show_recipient_name_to),
      update (number, type, brief, description, details, giver_type, recipient_type,
              max_recipients, show_responses_to, show_giver_name_to, show_recipient_name_to)
  on public.questions to authenticated;
grant insert, update on public.deadline_extensions to authenticated;

-- Functions: nothing for public, then explicit grants.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- Needed by RLS policies and column defaults when evaluated as the calling role
grant execute on function public.has_perm(uuid, text), public.session_course(uuid),
  public.can_create_course(), public.new_access_token(), public.jwt_email() to authenticated;

-- Student RPCs
grant execute on function
  public.student_portal(text), public.student_get_session(text, uuid),
  public.student_submit(text, uuid, uuid, jsonb), public.student_get_results(text, uuid)
  to anon, authenticated;

-- Instructor RPCs
grant execute on function
  public.claim_instructor_invites(), public.instructor_submit(uuid, uuid, jsonb),
  public.instructor_get_submission(uuid), public.instructor_moderate(uuid, uuid, uuid, jsonb),
  public.instructor_preview(uuid, uuid), public.instructor_contrib_results(uuid),
  public.regenerate_student_token(uuid), public.publish_session(uuid), public.unpublish_session(uuid),
  public.copy_session(uuid, text, uuid), public.enroll_students(uuid, jsonb)
  to authenticated;
