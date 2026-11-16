-- question_recipients for every recipient type. Roster order: section, team, name.
begin;
\ir seed.sql

create function t.rec(p_q uuid, p_giver text, p_field text default 'display_name') returns text language sql as $$
  select coalesce(string_agg(case p_field when 'display_name' then display_name when 'key' then recipient_key else team_key end, ',' order by o), '')
  from (select r.*, row_number() over () as o from public.question_recipients(p_q, p_giver) r) x
$$;

do $$
declare
  s uuid := t.mk_session('r', interval '-1 day', interval '1 day');
  q uuid;
  alice text := t.sk('Alice');
  ins uuid;
begin
  q := t.mk_q(s, 1, 'text', 'self');
  perform t.eq(t.rec(q, alice), 'Alice', 'self (student)');
  perform t.eq(t.rec(q, alice, 'team'), 't:S1|T1', 'self carries the team key');
  q := t.mk_q(s, 2, 'text', 'none');
  perform t.eq(t.rec(q, alice), '(no recipient)', 'none: display name');
  perform t.eq(t.rec(q, alice, 'key'), 'none', 'none: key');
  q := t.mk_q(s, 3, 'text', 'students');
  perform t.eq(t.rec(q, alice), 'Alice,Bob,Carol,Dave,Erin,Frank,Gina,Hal,Ivy,Jon', 'students: all of the course in roster order, not course B');
  q := t.mk_q(s, 4, 'text', 'students_excluding_self');
  perform t.eq(t.rec(q, alice), 'Bob,Carol,Dave,Erin,Frank,Gina,Hal,Ivy,Jon', 'students_excluding_self');
  q := t.mk_q(s, 5, 'text', 'teams');
  perform t.eq(t.rec(q, alice), 'T1,T2,T3,T4', 'teams');
  perform t.eq(t.rec(q, alice, 'key'), 't:S1|T1,t:S1|T2,t:S2|T3,t:S2|T4', 'teams: keys include the section');
  q := t.mk_q(s, 6, 'text', 'teams_excluding_self');
  perform t.eq(t.rec(q, alice), 'T2,T3,T4', 'teams_excluding_self');
  q := t.mk_q(s, 7, 'text', 'own_team');
  perform t.eq(t.rec(q, alice, 'key'), 't:S1|T1', 'own_team');
  q := t.mk_q(s, 8, 'text', 'own_team_members');
  perform t.eq(t.rec(q, alice), 'Bob,Carol', 'own_team_members');
  perform t.eq(t.rec(q, t.sk('Hal')), 'Gina,Ivy,Jon', 'own_team_members for another giver');
  q := t.mk_q(s, 9, 'text', 'own_team_members_including_self');
  perform t.eq(t.rec(q, alice), 'Alice,Bob,Carol', 'own_team_members_including_self');
  q := t.mk_q(s, 10, 'text', 'instructors');
  perform t.eq(t.rec(q, alice), 'Manager,Observer,Tutor,owner', 'instructors (displayed): sorted by display name (code point order)');
  update public.course_instructors set is_displayed_to_students = false where email = 'obs@a.edu';
  perform t.eq(t.rec(q, alice), 'Manager,Tutor,owner', 'instructors: hidden instructor is left out');
  perform t.eq(t.rec(q, alice, 'team'), '', 'instructor recipients have no team key');

  -- instructor givers
  select id into ins from public.course_instructors where email = 'tut@a.edu';
  q := t.mk_q(s, 11, 'text', 'self', '{}', 'instructors');
  perform t.eq(t.rec(q, 'i:' || ins), 'Tutor', 'instructor giver: self');
  q := t.mk_q(s, 12, 'text', 'students', '{}', 'instructors');
  perform t.eq(t.rec(q, 'i:' || ins), 'Alice,Bob,Carol,Dave,Erin,Frank,Gina,Hal,Ivy,Jon', 'instructor giver: students');
  q := t.mk_q(s, 13, 'text', 'teams', '{}', 'instructors');
  perform t.eq(t.rec(q, 'i:' || ins), 'T1,T2,T3,T4', 'instructor giver: teams');
  q := t.mk_q(s, 14, 'text', 'instructors', '{}', 'instructors');
  perform t.eq(t.rec(q, 'i:' || ins), 'Manager,Tutor,owner', 'instructor giver: instructors');
  q := t.mk_q(s, 15, 'text', 'none', '{}', 'instructors');
  perform t.eq(t.rec(q, 'i:' || ins), '(no recipient)', 'instructor giver: none');

  -- mismatched givers resolve to nothing
  perform t.eq(t.rec(q, alice), '', 'student key on an instructor question: nothing');
  q := t.mk_q(s, 16, 'text', 'self');
  perform t.eq(t.rec(q, 'i:' || ins), '', 'instructor key on a student question: nothing');
  perform t.eq(t.rec(q, t.sk('Zed')), '', 'student of another course: nothing');
  perform t.eq(t.rec(q, 'garbage'), '', 'garbage key: nothing');
end $$;
rollback;
