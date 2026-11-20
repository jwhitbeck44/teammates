# 09 Second review fixes

Seven fixes from the second code review, most important first. Branch: `claude/review-fixes-2-y0jqby` (this session's Git setup requires that name; the brief said `review-fixes-2`). Nothing was pushed to `main`.

Database changes are in two new migrations; earlier migrations are untouched:
- `supabase/migrations/20261117000012_cron_secret.sql` (item 1)
- `supabase/migrations/20261117000013_second_review_fixes.sql` (items 2, 3, 4, 6)

New tests: `supabase/tests/second_review.test.sql` (43 assertions), new cases in `supabase/tests/cron.test.sql` and `sessions.test.sql`, 8 new Deno tests at the end of `supabase/functions/_shared/due.test.ts`, `web/src/lib/second-review.test.ts` (17 tests), and the shared fixture `supabase/tests/fixtures/has_recipients_cases.json`.

## 1. Email no longer depends on the legacy API keys

Source read first: the Supabase guide "Migrating to publishable and secret API keys" and the page "Authorization headers" (`functions/auth-headers`). supabase.com is blocked from this container, so I read both from their source in the `supabase/supabase` GitHub repository (`apps/docs/content/guides/...`), current master on 2026-11-17. Points used: legacy keys retire by the end of 2026; Edge Functions get `SUPABASE_SECRET_KEYS` and `SUPABASE_PUBLISHABLE_KEYS` as JSON objects keyed by name, the first key named `default`, next to the legacy variables; secret keys are not JWTs, and a key in `Authorization: Bearer` may be parsed as a JWT and rejected; for `pg_net` the guide sends the secret key in `apikey`, read from Vault.

Changed:
- `supabase/functions/_shared/keys.ts` (new, pure): `keyFromJson` (key `default`, else the first string value; null for missing or invalid JSON) and `pickKey` (new variable first, legacy second).
- `_shared/clients.ts`: `secretKey()` reads `SUPABASE_SECRET_KEYS`, falls back to `SUPABASE_SERVICE_ROLE_KEY`; `publishableKey()` reads `SUPABASE_PUBLISHABLE_KEYS`, falls back to `SUPABASE_ANON_KEY`. `serviceClient` and `callerClient` use them.
- `_shared/http.ts`: `cronAuthorized(req, secret)` compares header `x-cron-secret` with `CRON_SECRET` in constant time (the existing `safeEqual`); false when `CRON_SECRET` is unset or the header is missing.
- `email-dispatch/index.ts`: accepts the timer call only through `cronAuthorized`. The bearer check against the service key is removed, with no fallback. When `CRON_SECRET` is unset it logs "the function secret CRON_SECRET is not set" and answers 401.
- Migration 12: `invoke_email_dispatch()` reads Vault `project_url` and `cron_secret` and sends `Content-Type` and `x-cron-secret` only (no `Authorization`, no `apikey`). It no longer reads `service_role_key`.
- `.github/workflows/deploy-supabase.yml`: `CRON_SECRET` from the GitHub secret of that name is set as a function secret; when it is missing the step prints a warning (not a failure, so a deploy without email still works).
- Website key (DEPLOY.md steps 2 and 3 name it, and the legacy `anon` key retires too): `web/src/api/client.ts` reads `VITE_SUPABASE_PUBLISHABLE_KEY`, falling back to `VITE_SUPABASE_ANON_KEY`; `deploy-pages.yml` passes `vars.VITE_SUPABASE_PUBLISHABLE_KEY || vars.VITE_SUPABASE_ANON_KEY`. `recoverLinks` no longer sends the key in `Authorization` (the guide says API keys go in `apikey` only). `send-reminder` already sends the user's JWT in `Authorization` and the key in `apikey`.
- `supabase/config.toml` comment.
- DEPLOY.md: the table of collected items, step 2 (copy the publishable key, no secret key needed), step 3 (`VITE_SUPABASE_PUBLISHABLE_KEY`, `CRON_SECRET` added later), step 7 rewritten (make `cron_secret` in SQL with `gen_random_uuid()` twice, copy it to the GitHub secret `CRON_SECRET`, rerun the workflow, optional removal of the old `service_role_key` Vault secret), Troubleshooting (how to read `net._http_response`, what 401 means, two new rows in the table). ARCHITECTURE.md sections 10 and 11.

Decisions:
- The timer sends no Supabase key at all. `email-dispatch` has `verify_jwt = false`, so the platform should not need one, and `CRON_SECRET` alone decides. Sending the secret key in `apikey` (as the guide's pg_net example does) would put a second copy of the most powerful key into Vault for no gain.
- The cron secret is made in the Supabase SQL editor because both copies have to match and the deployer has no terminal. `gen_random_uuid()` is in core Postgres, so no extension is needed; two v4 UUIDs give 244 random bits.
- Deployed or not: I could not check. github.io and supabase.com both answer 403 through this container's proxy, and the repository holds no project ref. I found no evidence that the site is deployed.

run.sh and cron.test.sql: `run.sh` skips files matching `*_cron.sql` when pg_cron is absent (it is absent here). Migration 12 is named `..._cron_secret.sql`, which does not match, so it is always applied; it contains only the function, which needs neither pg_cron nor pg_net at creation. `cron.test.sql` applies migration 07 and then 12 itself, against stand-in `net` and `vault` schemas. It now checks: nothing is sent with only the old `service_role_key` secret, the call carries `x-cron-secret`, and no `Authorization` or `apikey` header and no trace of the old key are sent. The real `cron.schedule` call is still untested (unchanged from before).

Not verified (needs a live project): that `SUPABASE_SECRET_KEYS` and `SUPABASE_PUBLISHABLE_KEYS` are present and shaped as the guide says; that supabase-js 2.119 with an `sb_secret_` key reaches PostgREST with service rights and that `auth.getUser` works with an `sb_publishable_` key; that the functions gateway accepts the timer call with no `apikey` header when `verify_jwt = false`; that pg_net delivers the custom header; the Vault functions and the `net._http_response` table name in DEPLOY.md; the GitHub workflows (not run on GitHub). Type checks of the three functions pass (`deno check`).

## 2. Contribution results use the teams stored on the rows

Changed:
- Migration 13: `contrib_team_members(p_question)` returns `(student_id, team_key)`. Rules, in order: (1) a student who gave answers on the question is in the `giver_team_key` of those rows (latest row wins); (2) else a student listed in `giver_team_ids` of another giver's rows is in that row's team (latest row, by `updated_at` then `id`); (3) else the student's current team, but only when no stored row carries that team key. Students that no longer exist are left out. Helpers `team_key_section`, `team_key_team`.
- `contrib_team_result` takes members from `contrib_team_members` (same signature); member `section` and `team` are the stored team's. `contrib_student_view` looks up the student's stored team instead of the current one. `instructor_contrib_results` loops over the stored teams, ordered by section then team.
- TS: `contribTeamsFromRows(questionId, rows, students)` in `web/src/lib/results.ts`, same three rules. `buildResultsQuestions` sets the new `ResultsQuestion.contribTeams`, and `contribTeamsFor` in `lib/csv.ts` uses it when present. `listResponses` now selects `giver_team_key, giver_team_ids`; `ResponseRow` and `ResultsResponseInput` have the optional fields. Rows without them behave as the current roster (the old behaviour).

Result on the review's case: before and after the move, T1 is Alice 100/107, Bob 100/108, Carol 70/85, and the whole T1 block (diff, ratings received) is identical, in SQL (`second_review.test.sql`) and in the CSV statistics (`second-review.test.ts`).

Decisions on the cases the brief listed:
- Two givers of one team with different stored member lists (a student added mid-session): the team is everyone either list names. A giver who did not rate the newcomer has "not submitted" (-999) in that cell. Tested (Kim joins T4 after Gina answered).
- A team with no responses: current roster. Tested (T4 in the first session, T2 = Erin).
- A student with no stored record whose current team does have stored rows (Dave in the review's case): left out of every team for that question. I first put him in his current team. The other members' CC and PC did not change (contrib_calc skips not-submitted cells, checked with a 4 x 4 matrix), but their "ratings received" gained an N/A and Carol's own claim list gained a "-999" entry, so the output still changed. Cost: Dave is missing from the instructor contribution table for that session. He has no ratings in it.
- A deleted student: left out. `students_cleanup` already deletes the rows they gave and received, so the team is recomputed from the remaining members; this changes the numbers, as it did before, and is the instructor's deliberate act.
- `contrib_student_view` for a student who has since moved: uses the team the student was rated in. Carol, moved to T2, sees team view 85 and her own claim 70 with others [120, 110]. Dave, moved into T1 later, gets no contribution summary for that session.
- The rules apply to open sessions too. During an open session a giver's own rows are re-stamped on every save, so a student who moves mid-session and saves again is placed in the new team.

Issues: the SQL tie-break is `updated_at desc, id desc` with microsecond timestamps; the TS one uses `Date.parse` (milliseconds). They could disagree only when two different givers' rows name the same student under different team keys within the same millisecond.

## 3. Student pages show the close time, not close plus grace

Changed:
- Migration 13: `student_shown_deadline(session, student)` = the extension if there is one, else `closes_at` (same rule as `studentShownDeadline` in `_shared/due.ts`, which the emails use). `student_session_payload` (so `student_get_session` and `instructor_preview`) and `student_portal` return it as `shown_deadline`. `deadline` stays the real cutoff and still drives `status`.
- TS: `shownDeadline()` in `lib/time.ts`; `printedDeadline()` and an extra `shownDeadline` argument to `effectiveStatus()` in `lib/studentView.ts` (an `open` session past the printed deadline but before the cutoff displays as `grace`, "Late period"). `StudentPortal.tsx` and `StudentSubmit.tsx` print `shown_deadline` and count down to it. The late-period text is now "The deadline has passed. You can still save for a few minutes. Save now." Older payloads without `shown_deadline` fall back to `deadline`.

Decision: an extension shorter than the grace period shows the extension; the real cutoff stays close plus grace (tested).

## 4. Questions answered out of questions the student can answer

Changed:
- Migration 13: `student_question_counts(session, student)` counts student-giver questions with at least one row from `question_recipients` for the student, and of those, the ones with a saved row. `student_portal` returns `questions_answerable` and `questions_answered` per session; `submitted` is kept.
- Portal: the badge reads "3 of 5 questions answered" (green when all are answered, "No questions for you" when none apply) via `answeredText()` in `lib/studentView.ts`.
- Status page (`SessionStatus.tsx`): the Status column is now "Questions answered" ("3 of 5"; "No questions"), the heading adds "N have answered every question", a new button **Select students with unanswered questions** sits next to the unchanged **Select non-submitters**, and the hint explains both. `questionProgress()` and `studentsWithUnanswered()` in `lib/results.ts` use `resolveRecipients`; the page now also loads the instructor list (for questions to instructors) and `listResponseMeta` returns `question_id`.
- `submittedAll` in `_shared/due.ts` (closing-soon email) skips questions with no recipients for the student, through the new `hasRecipients()`. `email-dispatch` now selects `section, team` of students, `recipient_type` of questions, and `course_instructors(course_id, is_displayed_to_students)`. Missing data counts the question as answerable (the old behaviour).

Keeping the sides in agreement: `has_recipients_cases.json` (14 cases over all recipient types, team of one, one-team course, one-student course, no instructor shown) is run by the Deno test against `hasRecipients` and by the web test against `resolveRecipients`. The SQL portal test and the web `questionProgress` test use the same layout (Alice 1 of 3, Frank as a team of one 1 of 2, 2 of 3 when no instructor is shown).

Decision: a question counts as answered with at least one saved row, also when the student answered for only some recipients. This matches `submittedAll` before and the brief's "questions answered".

## 5. Failed emails are retried and shown

Changed:
- `_shared/due.ts`: `MAX_EMAIL_ATTEMPTS = 3`. `logStates()` reads the log per student, session and kind: a `sent`, `skipped` or `pending` row means done; `failed` rows are counted, and three failures also mean done. `planDueEmails` plans an email again after one or two failures and sets `attempt` on each planned email (new optional field on `PlannedEmail`). `stampablePlans(plans, outcomes)` allows a stamp only when every email of the plan was attempted and none failed with tries left.
- `_shared/send.ts`: `SendSummary.outcomes`, one entry per attempted email. `email-dispatch` stamps through `stampablePlans` and leaves `outcomes` out of its JSON answer and log line.
- Status page: card "Emails for this session" with counts by kind and status (sent, failed, skipped, pending) and a table of failed sends (time, kind, address, error, "Later sent"). `listEmailLog()` in `api/instructor.ts` reads `email_log` (policy `email_log_select`, `modify_sessions`); `summarizeEmailLog()` in the new `lib/emailLog.ts`. The card shows for instructors with `modify_sessions` only, matching the policy.

Decisions: `skipped` stays done, as the brief asked. Reminders (`send-reminder`) are not retried: the instructor sees the counts at once and can resend. The counts count rows (tries), so an email that failed once and was then sent appears in both columns; "Later sent" in the failure table shows that it got through.

Issue: the timer runs every 15 minutes, so the three tries happen within about 30 minutes. A provider outage longer than that leaves those students without the automatic email; the Status page shows them.

## 6. Copying a session gives new times

Changed:
- Migration 13: `session_default_times(time_zone)` = tomorrow 08:00 and eight days from today 23:59 in that zone; `copy_session` uses it with the target course's zone.
- `defaultTimes` moved from `SessionsTab.tsx` into `lib/time.ts` as `defaultSessionTimes()` (same rule, now tested against Tokyo and Denver). The copy prompt says the copy gets new times.

Decision on the results time: a `custom` results time is set to the new close time plus the original gap between close time and results time, and is moved to the new open time if that would be earlier. So a past results time cannot make the copy published (and cannot trigger the published email) before it opens. `at_open` and `later` are copied as they are, with `results_visible_at` null. Tested: open source, past results time, results time before the new open, `at_open`.

## 7. The timer loads only publishable sessions

`email-dispatch/index.ts`: the published query adds `.or("published_at.not.is.null,results_visibility.in.(at_open,custom)")`. The planner still re-checks `isPublished`. Not testable here (needs PostgREST).

## Noticed and left alone

- `SessionsTab` "Submitted N / total" still counts students with at least one response. Its hint says so.
- Results CSV response rows and the by-giver and by-recipient views label students with their current team, while the contribution statistics use the stored team. After the review's move, Carol's response rows say T2 and her statistics row says T1.
- The Status page "Deadline" column and `instructor_get_submission` still show close time plus grace (instructor views).
- The Vite build warns that a chunk is larger than 500 kB. The warning is the same at the starting commit.
- Student pages and the Status page were type-checked and built, not opened in a browser.

## Test counts

| Suite | Before (2026-11-16) | After |
|---|---|---|
| `bash supabase/tests/run.sh` | 13 files, 720 assertions | 14 files, 769 assertions, all pass |
| `cd web && npm ci && npm test && npm run build` | 17 files, 341 tests | 18 files, 358 tests, all pass; build passes |
| `deno test supabase/functions/_shared/` (Deno 2.9.6 from npm) | 34 tests (run today on the starting commit; not run in the review) | 42 tests, all pass |

Also `deno check` on the three function entry points passes.

## Manual steps for the deployer

1. Supabase: **Settings, API Keys**, tab **Publishable and secret API keys**. If it shows **Create new API keys**, click it. Copy the publishable key (`sb_publishable_...`). DEPLOY.md step 2.
2. GitHub variable `VITE_SUPABASE_PUBLISHABLE_KEY` = the publishable key (or put it into the existing `VITE_SUPABASE_ANON_KEY`). DEPLOY.md step 3.
3. Supabase SQL editor: create Vault secrets `project_url` and `cron_secret`, then show `cron_secret`. DEPLOY.md step 7, steps 1 to 3.
4. GitHub secret `CRON_SECRET` = that value. DEPLOY.md step 7, step 4.
5. Run the **Deploy Supabase** workflow (applies migrations 12 and 13, sets `CRON_SECRET`), then the Pages workflow. A merge of this branch into `main` runs both by itself.
6. Optional: delete the old Vault secret `service_role_key` (DEPLOY.md step 7, last paragraph).
7. Check once on the live project: after 15 minutes, `net._http_response` shows status 200 for the timer call (DEPLOY.md Troubleshooting), and a test session's Status page lists the emails.
