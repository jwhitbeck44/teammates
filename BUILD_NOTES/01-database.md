# 01 Database layer

Files: `supabase/migrations/20261116000001..7_*.sql`, `supabase/tests/{shim.sql,seed.sql,run.sh,*.test.sql}`.
Run everything with `supabase/tests/run.sh` (re-execs as user `pgtest` when run as root; optional argument filters test files by name). Last run: 9 files, 601 assertions, all passing.

## Migrations

| File | Contents |
|---|---|
| `..01_schema.sql` | Tables, constraints, indexes (kept from the previous agent, unchanged). |
| `..02_rls.sql` | `has_perm`, `session_course`, `can_create_course`, `jwt_email`, jsonb helpers; email normalising trigger; course, instructor, student, session, extension and question triggers (including `validate_question`); RLS policies. |
| `..03_functions.sql` | `session_is_published`, `student_deadline`, `student_status`, `question_recipients`, `validate_answers`, `can_view`, `contrib_*` math, `contrib_team_result`. Internal; not granted to clients. |
| `..04_student_rpcs.sql` | `student_portal`, `student_get_session`, `student_submit`, `student_get_results` and internal helpers. |
| `..05_instructor_rpcs.sql` | Instructor RPCs. |
| `..06_grants.sql` | Table and function privileges. |
| `..07_cron.sql` | `invoke_email_dispatch()` and the `pg_cron` schedule (every 15 minutes, job name `email-dispatch`). Guarded: creates the schedule only when `pg_cron` and `pg_net` are available; the function itself returns quietly if `net` or Vault is missing, and logs a warning if the secrets `project_url` / `service_role_key` are absent. |

## Deviations from ARCHITECTURE.md

1. **Student deadline (lead decision).** `student_deadline = greatest(extension.closes_at, closes_at + grace)` when an extension exists, else `closes_at + grace`. Supersedes section 5. `student_status` is `open` until `closes_at` (or until the extension ends), `grace` until `closes_at + grace`, then `closed`.
2. **Only a coowner may create, promote, demote or delete coowner rows** (policies on `course_instructors`). Without this a manager could make themselves coowner.
3. **Column-level grants.** Clients cannot write `students.access_token`, `course_instructors.user_id` or `email` after creation, `sessions.published_at`, the three `*_email_sent_at` stamps, `created_by`. Use the RPCs (`regenerate_student_token`, `publish_session`, `unpublish_session`, `claim_instructor_invites`). Table-level grants are therefore columns lists, not whole tables.
4. **Question changes delete responses in the database**, not only in the UI: any change to `type`, `giver_type`, `recipient_type` or `details` other than `recommendedLength` deletes the question's responses. Changing `brief`, visibility lists, `max_recipients` or `description` keeps them.
5. **`claim_instructor_invites`** only claims when `auth.users.email_confirmed_at` is set, and uses the email in `auth.users`, not the JWT. Residual risk for DEPLOY.md: if email confirmations are off, Supabase auto-confirms at sign-up, so anyone who knows an invited address can sign up with it and claim the invite. Same for the allowlist.
6. **`question_recipients`, `validate_answers`, `can_view`, `contrib_team_result` are internal** (no execute for `anon` or `authenticated`). The browser has its own TS versions; the RPCs call the SQL ones.
7. **Error codes follow `web/src/lib/errors.ts`** (for example `deadline_passed`, `empty_text`, `not_on_step`, `not_enough_distinct`). Four codes are raised that are not in that file: `last_coowner`, `invalid_time_zone`, `name_taken`, `already_published`. Please add them to `errors.ts`.
8. **Visibility lists are validated like the TS** (`invalid_visibility` for unknown values, duplicates, a name right without the response right; `contrib_visibility_pair`).
9. **Blank section or team in `enroll_students`** becomes "Default Section" / "Default Team" (the UI does the same).
10. Added RPC **`instructor_get_submission`** (not in the contract) so the UI can answer instructor-giver questions without resolving recipients itself.
11. `publish_session` requires `opens_at <= now()` (`not_open_yet`) and raises `already_published` if the session is already published (including by `at_open` or `custom` time). `unpublish_session` raises `not_published` otherwise.

## Decisions not covered by ARCHITECTURE.md

- Errors are `raise exception '<code>'` so `error.message === code`. `validate_answers` puts the offending `recipient_key` in `error.details`; `validate_question` puts the offending field in `error.details`. Each question-level failure raises only the first problem.
- Permission failures, missing rows and unknown ids in instructor RPCs all raise `forbidden` (ids cannot be probed). Student RPCs raise `not_found` for ids outside the student's course.
- `has_perm(course, perm)` also accepts `'read'` (any linked instructor).
- Direct writes to `students` and `sessions` go through triggers that raise the same codes as the TS validators (`required_field_missing`, `too_long`, `forbidden_char`, `invalid_email`, `team_looks_like_email`, `section_too_large`, `invalid_time_range`, `invalid_grace`, `invalid_extension`). Strings are trimmed; students' email is lowercased.
- Deleting a student or instructor deletes the responses they gave or received. Responses keyed by a team (`t:...`) are not touched when a team is renamed.
- `student_get_results` leaves out questions with nothing to show, sorts rows by displayed names with random tie-breaks, and never returns ids, keys or emails of other people. Hidden names are the literal `Anonymous`; recipient `none` is always `(no recipient)`.
- Roster order in SQL uses `collate "C"` (same as the TS code point comparison).
- `instructor_submit` is allowed from `opens_at` to `closes_at + grace`. It stores `updated_by = 'instructor'`; moderation stores the moderator's email.
- Updating a course's `created_by` is not allowed; `created_by` must equal the caller on insert.
- `max_recipients` caps the number of answered rows (`too_many_recipients`); for `rank_recipients` ranks go up to `min(max_recipients, recipients)`.

## Error codes raised by SQL

Access: `invalid_token`, `forbidden`, `not_found`, `not_open_yet`, `deadline_passed`, `not_published`, `already_published`, `not_a_giver`, `name_taken`, `last_coowner`, `invalid_input`.
Answers: see the list above `validate_answers` in `..03_functions.sql` (`not_a_recipient`, `duplicate_recipient`, `too_many_recipients`, `invalid_answer`, `empty_text`, `not_a_choice`, `other_not_allowed`, `empty_other`, `duplicate_choice`, `too_few_selected`, `too_many_selected`, `out_of_range`, `not_on_step`, `sum_mismatch`, `negative_points`, `below_min_point`, `above_max_point`, `not_enough_distinct`, `not_all_distinct`, `wrong_option_count`, `duplicate_rank`, `rank_out_of_range`, `too_few_ranked`, `too_many_ranked`, `invalid_contrib_value`, `contrib_all_required`, `invalid_rubric_choice`, `no_rubric_answer`).
Questions: the `invalid_*`, `brief_required`, `too_few_choices`, `empty_choice`, `duplicate_option`, `contrib_conflict`, `contrib_visibility_pair` codes of `errors.ts`.
Roster and sessions: as in item 'Direct writes' above, plus `invalid_time_zone`.

## RPC signatures (all return jsonb)

Sentinels in contrib output: `-999` not submitted, `-9999` not available, `-101` not sure.

### Student (anon and authenticated)

- `student_portal(p_token text)` -> `{course:{name,code,time_zone}, student:{name,team,section,email}, sessions:[{id,name,opens_at,closes_at,deadline,status,published,submitted}]}`. `status` is `open|grace|closed`; only opened sessions are listed, newest first.
- `student_get_session(p_token text, p_session uuid)` -> `{course:{name,code,time_zone}, student:{name,team,section}, session:{id,name,instructions,opens_at,closes_at,grace_minutes,deadline,status,published}, questions:[{id,number,type,brief,description,details,giver_type,recipient_type,max_recipients, recipients:[{recipient_key,display_name,team_key}], answers:[{recipient_key,answer,giver_comment}]}]}`. `status` can be `not_open` only through `instructor_preview`.
- `student_submit(p_token text, p_session uuid, p_question uuid, p_answers jsonb)` -> `{saved:n}`. `p_answers` is `[{recipient_key, answer, giver_comment?}]`; `[]` deletes.
- `student_get_results(p_token text, p_session uuid)` -> `{course, student:{name,team,section}, session:{id,name}, questions:[{id,number,type,brief,description,details, responses:[{giver_name,recipient_name,answer,giver_comment,is_own,recipient_is_me}], contrib?:{my_claim:{own,others:[int]}, team_view_of_me:{own,others:[int]}}}]}`. Contrib questions have `responses: []` and `contrib` only when the student may see responses about themselves and the team has answers.

### Instructor (authenticated)

- `claim_instructor_invites()` -> `{claimed:n}`
- `instructor_submit(p_session uuid, p_question uuid, p_answers jsonb)` -> `{saved:n}`
- `instructor_get_submission(p_session uuid)` -> `{course, instructor:{id,display_name}, session:{id,name,instructions,opens_at,closes_at,grace_minutes,deadline,status,published}, questions:[same as student_get_session]}`
- `instructor_moderate(p_session uuid, p_question uuid, p_student uuid, p_answers jsonb)` -> `{saved:n}`
- `instructor_preview(p_session uuid, p_student uuid)` -> same as `student_get_session` (no open check)
- `instructor_contrib_results(p_question uuid)` -> `{question_id, students:[{student_id,section,team,team_key,name,email,claimed,perceived,diff,ratings_received:[int]}]}`; `diff = -999` when either side is negative; `ratings_received` sorted descending with sentinels kept.
- `regenerate_student_token(p_student uuid)` -> `{access_token}`
- `publish_session(p_session uuid)` -> `{published:true, published_at}`; `unpublish_session(p_session uuid)` -> `{published:false}`
- `copy_session(p_session uuid, p_new_name text, p_target_course uuid default null)` -> `{session_id}`
- `enroll_students(p_course uuid, p_rows jsonb)` -> `{created, updated, errors:[{row, code}]}`; `row` is 1-based; any error means nothing is written (`created = updated = 0`). Codes: `required_field_missing, too_long, forbidden_char, invalid_email, team_looks_like_email, duplicate_email` (second and later occurrence), `section_too_large` (every incoming row of a section whose final size is over 100), `invalid_input` (row not an object). A non-array `p_rows` raises `invalid_input`.
- `has_perm(p_course uuid, p_perm text)` -> boolean (callable by authenticated; used by `send-reminder`).

### Other grants for `authenticated`

`has_perm`, `session_course`, `can_create_course`, `new_access_token`, `jwt_email` (needed by RLS and column defaults), plus table access through RLS. Responses are `select` only. `instructor_allowlist` has no client access; the deployer inserts rows with the SQL editor.

## What the email functions rely on

- `sessions`: `opens_at, closes_at, grace_minutes, closing_email_enabled, published_email_enabled, opened_email_sent_at, closing_email_sent_at, published_email_sent_at, results_visibility, results_visible_at, published_at`. Stamps are writable only with the service role; unpublish clears `published_email_sent_at`.
- Published test: `session_is_published(sessions)` or `(uuid)` in SQL (service role may execute; the Edge Functions can also recompute it from the columns).
- `students`: `id, course_id, name, email, access_token, section, team`. `deadline_extensions(session_id, student_id, closes_at)`. Deadline rule: use the lead decision (greatest of extension and `closes_at + grace`); `student_deadline(session, student)` gives it in SQL.
- `email_log(session_id, kind, to_email, student_id, status, error, created_at)`; writes need the service role (clients cannot write). Instructors with `modify_sessions` can read their sessions' rows.
- `has_perm(p_course, p_perm)` callable with the instructor JWT. Course time zone: `courses.time_zone`. Course display name: `courses.name`, `courses.code`.
- The service role has all privileges on all tables and functions (granted in `..06_grants.sql`).
- The cron job posts `{}` to `<project_url>/functions/v1/email-dispatch` with `Authorization: Bearer <service_role_key>` and a 30 second timeout.

## Issues encountered

- psql autocommit makes `set local role` last one statement, so every test file runs inside `begin; ... rollback;`.
- `jsonb || jsonb` flattens arrays; appending a row needs `jsonb_build_array(...)` (bug found by the fixtures).
- `raise ... detail = null` raises an error; the error helpers coalesce to an empty string.
- The grants migration revokes default execute privileges, which also affects later helper functions in tests; `seed.sql` sets default privileges in schema `t`.
- `pg_cron` and `pg_net` are not installed locally: the cron migration is skipped by `run.sh`, but `cron.test.sql` runs the migration file itself (guard path) and checks `invoke_email_dispatch()` against stand-in `net` and `vault` schemas. The real `cron.schedule` call is untested.
- The TEAMMATES fixture file's other_tests are tested against SQL helper functions (`contrib_normalize`, `contrib_remove_self`, ...); the 11 matrix cases are tested through `contrib_calc` and again end to end through responses and `contrib_team_result` (cases containing `-9999` as raw input are covered only by `contrib_calc`).
- Not verified: behaviour on a real Supabase project (PostgREST role switching, Vault, pg_net argument names). `net.http_post` is called with named arguments `url, headers, body, timeout_milliseconds`.
