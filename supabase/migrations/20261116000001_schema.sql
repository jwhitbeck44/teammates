-- Schema for the peer feedback app (ARCHITECTURE.md section 5).
-- Tables, constraints and indexes only. Functions, triggers, policies and grants
-- live in the later migrations.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- instructor_allowlist
-- ---------------------------------------------------------------------------
create table public.instructor_allowlist (
  email text primary key,
  constraint instructor_allowlist_email_norm check (email = lower(btrim(email)))
);

-- ---------------------------------------------------------------------------
-- courses
-- ---------------------------------------------------------------------------
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  institute text,
  time_zone text not null default 'America/Denver',
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint courses_code_nonblank check (btrim(code) <> ''),
  constraint courses_name_nonblank check (btrim(name) <> '')
);

-- ---------------------------------------------------------------------------
-- course_instructors
-- ---------------------------------------------------------------------------
create table public.course_instructors (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  email text not null,
  user_id uuid references auth.users (id) on delete set null,
  display_name text not null,
  role text not null check (role in ('coowner', 'manager', 'observer', 'tutor')),
  is_displayed_to_students boolean not null default true,
  created_at timestamptz not null default now(),
  unique (course_id, email),
  constraint course_instructors_email_norm check (email = lower(btrim(email))),
  constraint course_instructors_email_nonblank check (email <> ''),
  constraint course_instructors_name_nonblank check (btrim(display_name) <> '')
);
create index course_instructors_user_idx on public.course_instructors (user_id);
create index course_instructors_email_idx on public.course_instructors (email);

-- ---------------------------------------------------------------------------
-- students
-- ---------------------------------------------------------------------------
create function public.new_access_token() returns text
language sql volatile security definer set search_path = public, extensions, pg_temp
as $$
  select translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
$$;

create table public.students (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  section text not null default 'Default Section',
  team text not null default 'Default Team',
  name text not null,
  email text not null,
  comments text,
  access_token text not null unique default public.new_access_token(),
  created_at timestamptz not null default now(),
  unique (course_id, email),
  constraint students_email_norm check (email = lower(btrim(email))),
  constraint students_email_len check (email <> '' and length(email) <= 254),
  constraint students_name_ok check (btrim(name) <> '' and length(name) <= 100 and name !~ '[|%]'),
  constraint students_team_ok check (btrim(team) <> '' and length(team) <= 60 and team !~ '[|%]'),
  constraint students_team_not_email check (team !~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  constraint students_section_ok check (btrim(section) <> '' and length(section) <= 60 and section !~ '[|%]'),
  constraint students_comments_len check (comments is null or length(comments) <= 500)
);
create index students_course_idx on public.students (course_id, section, team, name);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id) on delete cascade,
  name text not null,
  instructions text not null default '',
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  grace_minutes int not null default 15
    check (grace_minutes between 0 and 30 and grace_minutes % 5 = 0),
  results_visibility text not null default 'later'
    check (results_visibility in ('at_open', 'custom', 'later')),
  results_visible_at timestamptz,
  published_at timestamptz,
  closing_email_enabled boolean not null default true,
  published_email_enabled boolean not null default true,
  opened_email_sent_at timestamptz,
  closing_email_sent_at timestamptz,
  published_email_sent_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (course_id, name),
  constraint sessions_times check (closes_at > opens_at),
  constraint sessions_name_ok check (btrim(name) <> '' and length(name) <= 64 and name !~ '[|%]'),
  constraint sessions_custom_time check (results_visibility <> 'custom' or results_visible_at is not null)
);
create index sessions_course_idx on public.sessions (course_id);

-- ---------------------------------------------------------------------------
-- questions
-- ---------------------------------------------------------------------------
create table public.questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  number int not null,
  type text not null check (type in (
    'text', 'mcq', 'msq', 'numscale', 'constsum_options', 'constsum_recipients',
    'contrib', 'rubric', 'rank_options', 'rank_recipients')),
  brief text not null,
  description text not null default '',
  details jsonb not null default '{}',
  giver_type text not null check (giver_type in ('students', 'instructors')),
  recipient_type text not null,
  max_recipients int check (max_recipients is null or max_recipients >= 1),
  show_responses_to text[] not null default '{}',
  show_giver_name_to text[] not null default '{}',
  show_recipient_name_to text[] not null default '{}',
  constraint questions_number_unique unique (session_id, number) deferrable initially deferred
);
create index questions_session_idx on public.questions (session_id, number);

-- ---------------------------------------------------------------------------
-- responses (written only through RPCs)
-- ---------------------------------------------------------------------------
create table public.responses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  giver_key text not null,
  recipient_key text not null,
  answer jsonb not null,
  giver_comment text,
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (question_id, giver_key, recipient_key)
);
create index responses_session_idx on public.responses (session_id);
create index responses_giver_idx on public.responses (session_id, giver_key);
create index responses_recipient_idx on public.responses (session_id, recipient_key);

-- ---------------------------------------------------------------------------
-- deadline_extensions
-- ---------------------------------------------------------------------------
create table public.deadline_extensions (
  session_id uuid not null references public.sessions (id) on delete cascade,
  student_id uuid not null references public.students (id) on delete cascade,
  closes_at timestamptz not null,
  primary key (session_id, student_id)
);

-- ---------------------------------------------------------------------------
-- email_log (written by Edge Functions with the service role)
-- ---------------------------------------------------------------------------
create table public.email_log (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.sessions (id) on delete set null,
  kind text not null,
  to_email text not null,
  student_id uuid references public.students (id) on delete set null,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  error text,
  created_at timestamptz not null default now()
);
create index email_log_session_idx on public.email_log (session_id, kind);
create index email_log_to_idx on public.email_log (to_email, kind, created_at);
