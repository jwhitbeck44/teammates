# 05 Instructor pages

## Changes made

New or replaced files (all under `web/src/` unless noted):

- `api/instructor.ts`: wrappers over supabase-js and RPCs. Throws `ApiError` (`code` = what the database raised, `message` = plain text for known codes, `recipient_key` from the error details), so `SubmissionForm`'s `mapRpcError` shows the right text and row. `errorText(e)` gives UI text; `isRlsDenied(e)` detects the allowlist refusal.
- `auth/AuthContext.tsx`, `auth/RequireAuth.tsx`: session context (sign in, sign up, sign out, reset request, set new password after a recovery link). `claim_instructor_invites()` runs whenever a user id appears (sign-in or stored session on page load); `RequireAuth` waits for it before showing a page, so Home never loads before invites are claimed.
- `pages/Login.tsx`, `pages/instructor/{Home,CourseDetail,CourseEnroll,SessionEdit,SessionStatus,SessionResults,SessionModerate,SessionPreview}.tsx`.
- `components/instructor/`: `ui.tsx` (Page, useLoad, useAction, useCoursePerms, download helpers), `LocalDateTime`, `TimeZoneSelect`, `SessionSettings`, `StatsTable`, `StudentView` (shared body of moderate and preview), `InstructorAnswers`, `course/{SessionsTab,StudentsTab,InstructorsTab,SettingsTab}`, `questions/{QuestionEditor,DetailsEditors,VisibilityEditor,fields,draft}`.
- `styles/instructor.css`: all rules scoped under `.ins`.
- `lib/results.ts` plus `results.test.ts` (14 tests): party index, `toResultsResponses`, `toStatResponses`, `contribTeamsOf`, `missingForQuestion`/`missingResponses`, `buildResultsQuestions` (CSV input with missing rows, section filter, contrib members), `groupBy`, `submissionStatus`, `nonSubmitters`, `inSection`.
- `lib/errors.ts`: added `last_coowner`, `invalid_time_zone`, `name_taken`, `already_published`. Every other code raised in the migrations was already present (checked by script).
- `App.tsx`: same route table, wrapped in `AuthProvider`; instructor routes wrapped in `RequireAuth`; `/login`, `/s/...`, `/recover` are open.
- Tests: `components/instructor/questions/draft.test.ts` (defaults validate for all types, the response-deletion rule) and `render.test.ts` (editor renders for every type).

Status: `npm run typecheck`, `npm test` (331 tests), `npm run build` pass. Nothing was run against a live Supabase project.

## Decisions

- Role for button visibility comes from `course_instructors` (`getMyRole`, then `ROLE_PERMISSIONS`), not `has_perm`. The database still enforces; every write path surfaces its error.
- Course tabs use `?tab=` (HashRouter search params). Courses sort archived and active apart on Home.
- Question reorder: each update is its own request, so `renumberQuestions` first moves changed questions to numbers 10000+ and then to their final numbers. Add, delete and duplicate renumber the rest to 1..n.
- Response-deleting changes: `changeDeletesResponses` mirrors the SQL rule (type, giver, recipient or details other than `recommendedLength`). The editor shows a warning and the page asks for confirmation when the question has responses.
- Bulk extension: the status page sets one extended deadline for the selected students; "remove" works per row or for the selection. Validated with `validateExtension` and by the database trigger.
- Instructor-giver questions: a collapsible panel on the status page (no new route) using `SubmissionForm` with `instructor_get_submission` and `instructor_submit`.
- Moderation and preview both load `instructor_preview` (it returns the student's saved answers); moderation saves with `instructor_moderate`.
- Missing responses with `max_recipients`: the giver picks recipients, so a giver with no answers gets one "(any recipient)" row; a giver with some answers gets none.
- Section filter modes: giver, recipient, either, both. Instructors and "no recipient" have no section and never match a section filter.
- CONTRIB on the results page uses `instructor_contrib_results` (database numbers); the CSV uses `lib/csv` and `lib/contrib`.
- Reminders go in blocks of 200 students (the function's limit); "copy to me" is sent with the first block only.
- Downloaded CSVs get a UTF-8 byte order mark so Excel reads names correctly.
- Student links use `window.location.origin + pathname` plus `#/s/<token>`.
- Not in the allowlist: Home shows the explanation when a course insert is refused by RLS (Postgres code 42501).

## Deviations

- No new route; `App.tsx` keeps the contract route table.
- Duplicate-name errors (Postgres 23505, for example a repeated session name) show "That name or email is already used here." rather than `name_taken`, because `name_taken` is only raised by `copy_session`.

## Issues and open items

- Password reset with HashRouter: the recovery link returns tokens in the URL hash. supabase-js reads them and fires `PASSWORD_RECOVERY`, and the app then shows a "set a new password" form. The `redirectTo` must be allowed in the Supabase dashboard (Authentication, URL configuration). Untested against a real project.
- Results and status pages load all response rows (paged 1000 at a time). Fine for 45 to 200 students; the status page fetches only `giver_key` and `updated_at`.
- Submission counts on the session list read every student response row of the course's sessions; a big course with many sessions will be slower. A SQL count function would fix it.
- Instructor comments, section-level privileges and a deadline-extension email are not built (ARCHITECTURE.md section 3).
- Observers and tutors get a permission notice on the session edit page and no moderate or preview links on the status page (both RPCs need `modify_sessions`).
- Nothing here was exercised in a browser against PostgREST. The end-to-end tester should look first at: course create RETURNING, `students` update of `email`, `deadline_extensions` upsert (insert plus update grants and `on_conflict`), `copy_session` with a null target course, and `questions` renumbering.

## Operations per page (for the end-to-end tester)

Auth (all pages): `supabase.auth` getSession, onAuthStateChange, signInWithPassword, signUp, signOut, resetPasswordForEmail, updateUser; RPC `claim_instructor_invites`.

- **Home `/`**: select `courses` (order code); select `course_instructors` (course_id, role) where user_id = me; insert `courses` (code, name, institute, time_zone) returning row.
- **Course `/courses/:id`**: select `courses` one row; select `course_instructors` role where course_id and user_id.
  - Sessions tab: select `sessions` by course; select `students` (count); select `responses` (session_id, giver_key like `s:%`); insert `sessions` then insert `questions` (template; sessions deleted if the questions insert fails); RPC `copy_session`; delete `sessions`.
  - Students tab: select `students`; update `students` (section, team, name, email, comments); delete `students`; RPC `regenerate_student_token`. Link and CSV use `access_token` read from `students`.
  - Instructors tab: select `course_instructors`; insert (course_id, email, display_name, role, is_displayed_to_students); update (display_name, role, is_displayed_to_students); delete.
  - Settings tab: update `courses` (code, name, institute, time_zone, archived_at); delete `courses`.
- **Enroll `/courses/:id/enroll`**: select `courses`, `students`, `course_instructors` (role); RPC `enroll_students`.
- **Session edit `/sessions/:id/edit`**: select `sessions`, `courses`, `questions`, `students`, `responses` (question_id only, to count); update `sessions`; insert, update, delete `questions` (number updates for reordering); links to preview.
- **Status `/sessions/:id/status`**: select `sessions`, `courses`, `students`, `questions`, `responses` (giver_key, updated_at), `deadline_extensions`; upsert and delete `deadline_extensions`; RPC `publish_session`, `unpublish_session`; POST `${VITE_SUPABASE_URL}/functions/v1/send-reminder` with the user's access token and `apikey`; RPC `instructor_get_submission` and `instructor_submit` (instructor questions panel).
- **Results `/sessions/:id/results`**: select `sessions`, `courses`, `students`, `course_instructors`, `questions`, `responses` (full rows); RPC `instructor_contrib_results` per contrib question.
- **Moderate `/sessions/:id/moderate/:studentId`**: RPC `instructor_preview` (payload and saved answers); RPC `instructor_moderate` on each question save; select `sessions`, `courses` for the breadcrumb.
- **Preview `/sessions/:id/preview/:studentId`**: RPC `instructor_preview`; select `sessions`, `courses`.
