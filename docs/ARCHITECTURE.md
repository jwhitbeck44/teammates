# Peer feedback app: architecture and build contract

This file is the contract between the build steps. When code and this file disagree, fix one of them and note it in `BUILD_NOTES/`. Choices below are current defaults with reasons; change them if a reason stops holding.

The feature reference is `docs/teammates-spec.md` (derived from the TEAMMATES source, GPL-2.0). This project ports parts of TEAMMATES (the contribution calculation, template question text), so it is licensed GPL-2.0 and credits TEAMMATES in the README.

## 1. Stack

- Frontend: Vite + React + TypeScript, `HashRouter` (GitHub Pages has no server rewrites), `@supabase/supabase-js` v2. Plain CSS, no UI framework (fewer dependencies to break). Deployed to GitHub Pages by a GitHub Actions workflow.
- Backend: Supabase. Postgres with row-level security (RLS), SQL functions (RPCs) for all student access and all response writes, Supabase Auth for instructors, Edge Functions (Deno) for email, `pg_cron` + `pg_net` to call the email function every 15 minutes.
- Email: Resend HTTP API from the Edge Functions. The instructor UI also offers a CSV of every student's personal links so emails can go out by mail merge if email is not set up.

## 2. Repo layout

```
supabase/
  migrations/            numbered SQL migrations (schema, RLS, functions, cron)
  functions/
    _shared/             email templates, Resend client, due-email logic (pure TS)
    email-dispatch/      cron target: opened, closing-soon, published emails
    send-reminder/       instructor-triggered reminders and results reminders
    recover-links/       public: email me my links
  tests/
    shim.sql             local stand-in for Supabase's auth schema and roles
    *.test.sql           SQL tests
    run.sh               starts a throwaway local Postgres 16 and runs everything
web/
  src/lib/               pure TS shared logic (no React, no network): types, validation,
                         recipients, visibility, contrib math, statistics, CSV, templates
  src/api/               thin wrappers over supabase-js calls and RPCs
  src/pages/instructor/  instructor pages
  src/pages/student/     student token pages
  src/components/        shared UI pieces (question renderers, question editors)
.github/workflows/       deploy-pages.yml, deploy-supabase.yml
docs/                    ARCHITECTURE.md, teammates-spec.md, DEPLOY.md, INSTRUCTOR_GUIDE.md
BUILD_NOTES/             one summary file per build step: changes made, issues encountered
LICENSE                  GPL-2.0
```

## 3. Scope

Built:
- Courses with time zone, archive. Instructors invited by email with roles Co-owner, Manager, Observer, Tutor.
- Roster enroll by pasting or uploading CSV with columns `Section, Team, Name, Email, Comments` (TEAMMATES format). Edit, delete, regenerate a student's link, download all links as CSV.
- Sessions: instructions, open time, close time, grace period (0 to 30 min), results visibility (at open, at a set time, or later by manual publish), closing-soon email toggle, published email toggle, per-student deadline extensions, copy a session.
- Templates: "team peer feedback (point-based)" and "(percentage-based)", copied from TEAMMATES (spec section e), plus empty session.
- All 10 question types with the config options in the spec, except the items listed under "Not built".
- Feedback paths for givers `students` and `instructors` (table in section 6).
- Three visibility lists per question, with the TEAMMATES presets plus custom checkboxes.
- Student submission by personal link, no login. Save per question. Edit until close (plus grace, plus extension).
- Instructor: submission status per student, manual reminders, moderation (edit a student's answers), preview as a student, submit as instructor for instructor-giver questions.
- Results: by question with statistics, by giver, by recipient; missing responses; non-submitter list; CSV download in the TEAMMATES layout; publish and unpublish.
- Student results page that shows only what visibility allows, with "Anonymous" in place of hidden names, and the contribution summary for CONTRIB.
- Emails: session opened, closing soon (24h before, per-student deadline aware), results published, manual reminder, link recovery.

Not built (reason: rarely used in team peer evaluation, and each adds real code):
- `teams` as giver type; section-scoped recipient types (`STUDENTS_IN_SAME_SECTION`, `TEAMS_IN_SAME_SECTION`).
- MCQ/MSQ/rubric weights, MCQ dropdown mode, generating MCQ/MSQ options from the student or team list.
- Rich text (plain text with line breaks only).
- Section-level and session-level instructor privilege overrides; custom roles.
- Instructor comments on responses, student profiles, Google account "join", recycle bin, opening-soon and closed emails to instructors, deadline extension emails.

## 4. Identity and access

### Instructors
- Supabase Auth, email + password by default (needs no outgoing email to work). Magic link and Google sign-in can be turned on later in the Supabase dashboard without code changes.
- Creating a course requires the user's email to be in table `instructor_allowlist`. Reason: anyone can sign up on a public Supabase project; this stops strangers from using it. The deployer adds rows in the SQL editor (DEPLOY.md shows how).
- Being invited to a course (a row in `course_instructors` with that email) also lets a user in, even if not on the allowlist.
- `course_instructors.user_id` is null until the invited person signs in; RPC `claim_instructor_invites()` links all rows whose email matches `auth.jwt()->>'email'` (lowercased). The app calls it after every sign-in.

Permissions (names match TEAMMATES, spec section i):

| Role | modify_course | modify_instructors | modify_sessions | modify_students | view_results | submit |
|---|---|---|---|---|---|---|
| coowner | yes | yes | yes | yes | yes | yes |
| manager | no | yes | yes | yes | yes | yes |
| observer | no | no | no | no | yes | no |
| tutor | no | no | no | no | yes | yes |

`has_perm(p_course uuid, p_perm text) returns boolean`: SECURITY DEFINER, STABLE, `search_path = public`. True when `auth.uid()` has a linked `course_instructors` row for the course whose role grants the permission. All instructors of a course can read the course, its students, sessions and questions. Reading responses requires `view_results`.

### Students
- No accounts. Clients cannot read `students.access_token` (column grants); instructors with `modify_students` get the links from the RPC `instructor_student_links(p_course)`. Each student row has `access_token`: 32 random bytes, base64url, unique. Personal link: `<APP_URL>/#/s/<token>`.
- The `anon` role has no table privileges at all. It may execute only the `student_*` functions and nothing else. Every `student_*` function is SECURITY DEFINER with `search_path = public, pg_temp`, looks up the student by token first, and raises `invalid_token` (SQLSTATE `P0001`, message `invalid_token`) if there is no match.
- Regenerating a token invalidates the old link.

## 5. Schema

All ids are `uuid default gen_random_uuid()`. All timestamps are `timestamptz` stored in UTC. Emails are stored lowercased and trimmed (check constraint `email = lower(btrim(email))`).

```
instructor_allowlist(email text pk)

courses(id, code text not null, name text not null, institute text,
        time_zone text not null default 'America/Denver',
        archived_at timestamptz, created_by uuid references auth.users, created_at)

course_instructors(id, course_id fk cascade, email text not null, user_id uuid null references auth.users,
        display_name text not null, role text check in ('coowner','manager','observer','tutor'),
        is_displayed_to_students boolean default true, created_at,
        unique(course_id, email))
  -- inserting a course also inserts the creator as 'coowner' (trigger)
  -- a course must keep at least one coowner (trigger blocks removing or demoting the last one)

students(id, course_id fk cascade, section text not null default 'Default Section',
        team text not null default 'Default Team', name text not null, email text not null,
        comments text, access_token text not null unique, created_at,
        unique(course_id, email))
  -- limits from spec section j: name 100, team 60, section 60, email 254, comments 500,
  --   no '|' or '%' in name/team/section; at most 100 students per section

sessions(id, course_id fk cascade, name text not null, instructions text not null default '',
        opens_at timestamptz not null, closes_at timestamptz not null,
        grace_minutes int not null default 15 check (grace_minutes between 0 and 30 and grace_minutes % 5 = 0),
        results_visibility text not null default 'later' check in ('at_open','custom','later'),
        results_visible_at timestamptz null,          -- required when 'custom'
        published_at timestamptz null,                -- set by manual publish
        closing_email_enabled boolean not null default true,
        published_email_enabled boolean not null default true,
        opened_email_sent_at timestamptz, closing_email_sent_at timestamptz,
        published_email_sent_at timestamptz,
        created_by uuid, created_at,
        unique(course_id, name), check (closes_at > opens_at))

questions(id, session_id fk cascade, number int not null, type text not null,
        brief text not null, description text not null default '',
        details jsonb not null default '{}',
        giver_type text not null check in ('students','instructors'),
        recipient_type text not null,
        max_recipients int null,                      -- null = unlimited
        show_responses_to text[] not null default '{}',
        show_giver_name_to text[] not null default '{}',
        show_recipient_name_to text[] not null default '{}',
        unique(session_id, number) deferrable initially deferred)

responses(id, session_id fk cascade, question_id fk cascade,
        giver_key text not null, recipient_key text not null,
        answer jsonb not null, giver_comment text,
        updated_at timestamptz not null default now(), updated_by text,  -- 'student', or instructor email when moderated
        unique(question_id, giver_key, recipient_key))

deadline_extensions(session_id fk cascade, student_id fk cascade, closes_at timestamptz not null,
        primary key(session_id, student_id))

email_log(id, session_id uuid null, kind text, to_email text, student_id uuid null,
        status text check in ('sent','failed','skipped'), error text, created_at)
```

Keys used in `responses`:
- Student: `s:<student uuid>`. Instructor: `i:<course_instructors.id>`.
- Team: `t:<section>|<team>` (teams are unique per section, spec section j).
- No recipient: `none`. Self: the giver's own key.

Derived values (SQL functions, mirrored in `web/src/lib`):
- `session_is_published(s)`: `published_at is not null` or (`results_visibility = 'at_open'` and `now() >= opens_at`) or (`results_visibility = 'custom'` and `now() >= results_visible_at`).
- Unpublish sets `published_at = null`, `results_visibility = 'later'`, `published_email_sent_at = null`.
- `student_deadline(session, student)`: `greatest(extension.closes_at, closes_at + grace_minutes)` if an extension exists, else `closes_at + grace_minutes` (the TEAMMATES rule; changed on 2026-11-16 so an extension shorter than the grace period does not cut the grace period short). A student may submit when `opens_at <= now() < student_deadline`. Extensions must be later than `closes_at`.
- A session is visible to students from `opens_at` on (no separate "visible from" setting, as in TEAMMATES).

## 6. Questions

### Feedback paths

| Giver | Allowed recipient_type |
|---|---|
| students | `self, students, students_excluding_self, teams, teams_excluding_self, own_team, own_team_members, own_team_members_including_self, instructors, none` |
| instructors | `self, students, teams, instructors, none` |

Restrictions by type:
- `contrib`: only students to `own_team_members_including_self`.
- `constsum_recipients`, `rank_recipients`: no `self`, `own_team`, `none`.

Recipient resolution (`question_recipients(question_id, giver_key)` in SQL, `resolveRecipients()` in TS; both return `(recipient_key, display_name, team_key)` in roster order: section, team, name):
- `self`: the giver. `none`: one row, key `none`, name "(no recipient)".
- `students`: all students in the course. `students_excluding_self`: all but the giver.
- `teams`: all teams. `teams_excluding_self`: all but the giver's team. `own_team`: the giver's team.
- `own_team_members`: the giver's teammates. `own_team_members_including_self`: teammates and the giver.
- `instructors`: all `course_instructors` rows with `is_displayed_to_students = true`.
- `max_recipients`, when set, means the giver answers for up to that many of the resolved recipients (giver picks which).

### Types, `details` and `answer` JSON

Type strings are lowercase: `text, mcq, msq, numscale, constsum_options, constsum_recipients, contrib, rubric, rank_options, rank_recipients`.

| type | details | answer (one per response row) |
|---|---|---|
| text | `{recommendedLength?: int}` | `{text: string}` non-empty after trim |
| mcq | `{choices: string[], otherEnabled: bool}` | `{choice: string}` (one of choices) or `{other: string}` (needs otherEnabled, non-empty) |
| msq | `{choices, otherEnabled, minSelectable?: int, maxSelectable?: int}` | `{choices: string[], other?: string}`; `{choices: []}` without other = "none of the above" |
| numscale | `{min: number, max: number, step: number}` | `{value: number}` in range and on a step from min (tolerance 1e-9) |
| constsum_options | `{options: string[], points: int, pointsPerOption: bool, distribute: 'none'\|'some'\|'all', minPoint?: int, maxPoint?: int}` | `{points: int[]}` aligned with options; sum = total; no negatives; within min/max; 'some' means at least two different values; 'all' means all distinct |
| constsum_recipients | `{points: int, pointsPerOption: bool, distribute, minPoint?, maxPoint?}` | `{points: int}`; the sum and distribution rules apply across all of the giver's rows for the question; total = points x number of recipients answered when pointsPerOption |
| contrib | `{isZeroSum: bool, isNotSureAllowed: bool}` (not both true) | `{value: int}`, 0..200 step 5, or -101 if not-sure allowed; zero-sum means the giver's values sum to 100 x team size, and the giver must answer for every team member |
| rubric | `{choices: string[], subQuestions: string[], descriptions: string[][]}` | `{choices: int[]}` one index per sub-question, -1 = unanswered, at least one answered |
| rank_options | `{options: string[], minToRank?: int, maxToRank?: int, duplicatesAllowed: bool}` | `{ranks: (int\|null)[]}` aligned with options, 1..n |
| rank_recipients | `{minToRank?, maxToRank?, duplicatesAllowed}` | `{rank: int}` 1..number of recipients; duplicate and min/max rules apply across the giver's rows |

Validation lives in two places on purpose: `web/src/lib/validation.ts` for instant messages, and SQL (`validate_answers(question, giver_key, answers jsonb)`) as the authority. Both return the same error codes, listed in `web/src/lib/errors.ts` and in the SQL function's comments (for example `sum_mismatch`, `not_a_choice`, `out_of_range`, `duplicate_rank`, `not_a_recipient`, `too_many_recipients`). Question details are validated by `validate_question()` (SQL trigger on insert/update) and `validateQuestion()` (TS).

Changing a question's type, choices, options, scale, points or recipient type deletes its existing responses, after a confirm in the UI (spec section a).

## 7. Visibility

Values in the three lists: `recipient, giver_team_members, recipient_team_members, students, instructors`. UI rules from spec section d: granting a name right also grants the response right; removing the response right removes both name rights; the recipient always sees the recipient name.

`can_view(question, response, viewer_student) -> (sees_response, sees_giver_name, sees_recipient_name)`, implemented in SQL for students. For each list, the viewer qualifies for an entry if:
- `recipient`: the viewer is the recipient, or the recipient is the viewer's team.
- `giver_team_members`: the viewer is in the giver's team (the giver themself counts).
- `recipient_team_members`: the viewer is in the recipient's team, or the recipient is the viewer's team.
- `students`: any student in the course.
- `instructors`: never a student.

A giver always sees their own responses with full names. Instructors with `view_results` see everything; the hiding applies to students only.

Presets offered in the editor (from spec section d; TEAMMATES' remaining presets were not read, so these are the full list for now):
1. Shown anonymously to recipient and giver's team members, visible to instructors: responses `[instructors, recipient, giver_team_members]`, giver name `[instructors]`, recipient name `[instructors, recipient]`.
2. Shown anonymously to recipient, visible to instructors: responses `[recipient, instructors]`, giver name `[instructors]`, recipient name `[recipient, instructors]`.
3. Visible to recipient and instructors: responses, giver name and recipient name all `[recipient, instructors]`.
4. Visible to instructors only: all three `[instructors]`.
5. Custom: checkbox grid.

TEAMMATES also has "shown anonymously to recipient and instructors" (giver hidden even from instructors). It is left out because in this build instructors with `view_results` always see giver names, so that preset would promise anonymity it does not give. The `instructors` checkbox stays in the custom grid for compatibility but has no effect for instructors.

## 8. RPCs

All return `jsonb` unless noted. Errors are raised with `raise exception '<code>'` so the client can map them.

Student (role `anon` and `authenticated` may execute; SECURITY DEFINER):
- `student_portal(p_token)`: course name, student's own name/team/section, list of sessions that have opened: id, name, opens_at, closes_at, own deadline, status (`open`, `grace`, `closed`), published flag, submitted flag (has at least one response).
- `student_get_session(p_token, p_session)`: session info, instructions, questions for which the student is a giver, each with resolved recipients and the student's existing answers. Raises `not_open_yet` before opens_at. Never returns other students' answers or emails.
- `student_submit(p_token, p_session, p_question, p_answers jsonb)`: `p_answers` is `[{recipient_key, answer, giver_comment?}]`. Checks the deadline, that the student is a giver for the question, that each recipient_key is among the resolved recipients, runs `validate_answers`, then replaces this giver's rows for this question in one transaction. An empty array deletes them. Returns `{saved: n}`.
- `student_get_results(p_token, p_session)`: raises `not_published` unless published. Returns, per question, the responses the student may see per section 7, with `giver_name` / `recipient_name` set to `'Anonymous'` when hidden, and with no keys, ids or emails of hidden people. Responses given by the student are included and marked `is_own: true`. For `contrib`, individual responses are never returned; instead `{my_claim, team_view_of_me}` from section 9, when the student is allowed to see responses where they are the recipient.

Instructor (role `authenticated` only):
- `claim_instructor_invites()`: section 4.
- `instructor_submit(p_session, p_question, p_answers)`: for instructor-giver questions; needs `submit`; same rules as `student_submit` with giver key `i:<id>`.
- `instructor_moderate(p_session, p_question, p_student, p_answers)`: needs `modify_sessions`; ignores the deadline; sets `updated_by` to the instructor's email.
- `instructor_preview(p_session, p_student)`: needs `modify_sessions`; returns the same payload as `student_get_session` for that student.
- `instructor_contrib_results(p_question)`: needs `view_results`; per student: team, name, email, claimed, perceived, diff, ratings received.
- `regenerate_student_token(p_student)`: needs `modify_students`.
- `publish_session(p_session)`, `unpublish_session(p_session)`: need `modify_sessions`.
- `copy_session(p_session, p_new_name, p_target_course)`: needs `modify_sessions` in both courses; copies settings and questions, shifts nothing, clears sent-email stamps.
- `enroll_students(p_course, p_rows jsonb)`: needs `modify_students`; rows `[{section, team, name, email, comments}]`; upserts by email; returns `{created, updated, errors: [{row, code}]}`; all-or-nothing.

Everything else (courses, instructors, students, sessions, questions, extensions) the client writes through supabase-js with RLS checking `has_perm`. Responses have no insert/update/delete policies: they are written only through the RPCs above.

## 9. Contribution calculation

Port `TeamEvalResult.java` exactly (spec section b, test cases in `TeamEvalResultTest.java`). Implement twice: `web/src/lib/contrib.ts` and SQL `contrib_team_result(p_question, p_team_key)`. Both suites run the same fixtures from `supabase/tests/fixtures/contrib_cases.json` (generated from the Java test file), so the two implementations are tested against TEAMMATES' expected values and against each other.

Student view of a CONTRIB question (when allowed): `my_claim` = raw claimed row of the student (own value and others sorted descending), `team_view_of_me` = `{own: denormalizedAveragePerceived[i][i]}` only. TEAMMATES also shows the team's view of the others; this app leaves it out (review finding F4), because in a small team the student could solve for a teammate's individual rating.

## 10. Emails

- `email-dispatch` runs every 15 minutes (pg_cron calls it through pg_net with the service-role key in a header). Reason for 15 minutes rather than hourly: a manual publish then emails students within 15 minutes without a separate code path.
  - Opened: `opens_at <= now() < closes_at`, `opened_email_sent_at is null`, `opens_at > now() - interval '2 days'`. To every student. Set the stamp.
  - Closing soon: `closing_email_enabled`, session longer than 24h, now within 24h before the student's deadline, student has not submitted every question, no `email_log` row of kind `closing` for that student and session. Per student, so deadline extensions are handled. Set `closing_email_sent_at` when the session-wide pass runs.
  - Published: `published_email_enabled`, published, `published_email_sent_at is null`. To every student. Set the stamp.
- `send-reminder` (instructor JWT, needs `modify_sessions`): body `{session_id, student_ids[], kind: 'submit'|'results', copy_to_me: bool}`.
- `recover-links` (public): body `{email}`. Always answers `{ok: true}`. Sends one email listing links for every course where that email is a student, sessions opened in the last 180 days. Rate limit: at most 3 per email per hour, counted in `email_log`.
- Every send writes an `email_log` row. Emails contain the student's personal link, session name, course name, deadline in the course time zone.
- Secrets: `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`. If `RESEND_API_KEY` is missing, functions log `skipped` rows and return without error, so the app works without email.

## 11. Testing

- `supabase/tests/run.sh`: `initdb` a throwaway cluster in `/tmp`, start Postgres 16 on a free port, load `shim.sql` (roles `anon`, `authenticated`, `service_role`; schema `auth` with `users` table, `auth.uid()` and `auth.jwt()` reading `current_setting('request.jwt.claims', true)` as Supabase does), apply migrations in order (skipping the cron migration when `pg_cron` is absent), run `*.test.sql`, stop the cluster. Tests switch identity with `set local role ...` and `set local request.jwt.claims = '...'`.
- `web`: `vitest` for everything in `src/lib`.
- Required security tests: anon cannot select any table; an instructor of course A cannot read or write course B; an observer cannot write; a student token cannot read another course; `student_get_results` hides giver names per each preset; a student cannot submit after the deadline, for another giver, to a recipient not in the resolved list, or an invalid answer.

## 12. Build notes

Each build step writes `BUILD_NOTES/<nn>-<step>.md`: changes made, decisions not covered here, deviations from this file, issues encountered, and anything the next step needs to know.
