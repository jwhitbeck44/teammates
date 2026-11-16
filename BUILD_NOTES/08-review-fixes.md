# 08 Review fixes

Fixes for F1 to F12 of `07-review.md`. Database changes are in two new migrations
(`20261116000009_review_fixes.sql`, `20261116000010_recovery_slot.sql`); earlier migrations are untouched.
The FINDING assertions of `review_findings.test.sql` are inverted and now start with "FIXED Fn:".

## F1 Integers must be JSON integers (fixed)
- Changed: `jb_is_int` accepts only canonical integers (`^-?[0-9]{1,15}$` on the jsonb text), so `100.0`, `100.5` and out-of-range numbers are rejected with the existing `invalid_answer` (no new code needed; `1e2` is parsed by Postgres to `100` and stored as such). This also covers constsum points, ranks, rubric choices and the integer fields of question details. `contrib_team_result` reads values with `jsonb_typeof = 'number'`, clamps to -1000..1000 and rounds; anything else counts as "not submitted" (-999). The TS validator already used `Number.isInteger` (JS cannot tell 100.0 from 100), so no TS change.
- Proof: `review_findings.test.sql` ("FIXED F1: ..."): 100.0 and 100.5 rejected, 1e2 stored as `{"value": 100}`; rows inserted directly as postgres (`100.0`, `"abc"`, `1e400`) do not break `student_get_results` for any team nor `instructor_contrib_results`.
- Open: rows already stored with `100.0` by an old version are tolerated, not rewritten.

## F2 access_token hidden from clients (fixed)
- Changed: `revoke select` on `students` from `authenticated`, then column-level select without `access_token`; new RPC `instructor_student_links(p_course)` (needs `modify_students`) returns `[{student_id, section, team, name, email, token}]`. `web/src/api/instructor.ts`: `listStudents` names its columns, new `listStudentLinks`; `StudentsTab` loads links only with `modify_students`, hides the Link column, the Copy link buttons, the links hint and the "Download student links CSV" button for other roles; `buildStudentLinksCsv` takes `token`. `Student` type lost `access_token`, new `StudentLink` type.
- Proof: `review_findings.test.sql` "FIXED F2" (observer and tutor get 42501 on `access_token` and `select *`, RPC answers `forbidden`; a manager gets 10 links with the six keys; another course's owner gets `forbidden`). Existing tests that read tokens now use the `t.tok_of_email` helper (in `seed.sql`). `review_coverage` function list updated.

## F3 Visibility locked once answers exist (fixed)
- Changed: trigger `questions_visibility_lock` (fires after `questions_validate`, which already deletes responses on a type, path or details change) raises `visibility_locked` when any entry is ADDED to `show_responses_to`, `show_giver_name_to` or `show_recipient_name_to` and the question has responses. Removing entries and other edits stay allowed. UI: `QuestionEditor` gets `responseCount`, `VisibilityEditor` shows a plain note; `visibility_locked` message in `errors.ts`.
- Proof: "FIXED F3" assertions (all three lists, removal allowed, other edit allowed, no-response question allowed, type change that deletes responses allowed, Bob still sees `Anonymous`).
- Open: moving a student between teams after answers exist still changes team-based lists (not blocked; unchanged from the review note).

## F4 CONTRIB team view of teammates removed (fixed)
- Changed: `contrib_student_view` returns `team_view_of_me: {own}` only (`my_claim` unchanged). `studentView.ts`, `studentTypes.ts` types (`ContribClaim`, `ContribTeamView`), the summary lines, and `contribStudentView` in `lib/contrib.ts` (dropped `team_view_of_others`). `docs/INSTRUCTOR_GUIDE.md` "Differences from TEAMMATES" and ARCHITECTURE section 9 updated.
- Proof: "FIXED F4" (no `others` key, 125 appears nowhere, own and my_claim kept); `results.test.sql` updated; `studentView.test.ts`.

## F5 recover-links (fixed in code, not run against a live project)
- Changed: `claim_recovery_slot(email, limit, global)` (service_role only, advisory lock) counts rows of every status in the last hour (per address 3, global 200) and inserts a `pending` row in the same step; `email_log.status` now allows `pending`. `_shared/recovery.ts` (`deliverRecovery`) claims first, sends, then updates that row. The function answers `{ok:true}` at once and runs lookup and send through `EdgeRuntime.waitUntil` (falls back to awaiting when it is not available, in which case timing can still differ).
- Proof: `supabase/tests/recovery.test.sql` (16 assertions: limit, pending counted, global cap, window, grants); `due.test.ts` (claim before send, nothing sent when refused, 20 parallel calls with limit 3 give 3 sends, skipped and failed recorded, pending counted by `recoveryRateLimited`).
- Open: needs a deployed check that `EdgeRuntime.waitUntil` is present and the response is fast.

## F6 Secure email change (documented)
- `docs/DEPLOY.md` step 8, Setup A: keep "Secure email change" on, one sentence on the remaining risk. Not tested (needs GoTrue).

## F7 Password reset under HashRouter (fixed in code, UNVERIFIED against a live project)
- Changed: `api/client.ts` uses `flowType: 'pkce'`; `auth/recovery.ts` subscribes to `onAuthStateChange` at import time (before React mounts), remembers `PASSWORD_RECOVERY`, sets the hash to `#/` (guarded root, where `RequireAuth` shows the set-new-password screen) and removes any leftover `?code=` (supabase-js 2.119 already strips it after the exchange). `AuthProvider` starts from that flag and listens for later events. `redirectTo` stays origin + pathname.
- Not verified in a browser against a real project; try it once (reset link, new password, sign in) before relying on it. The redirect URL must be allowed in Auth settings (DEPLOY.md step 8).

## F8 Hidden giver revealed by recipient name (fixed)
- Changed: `can_view_keys` (SQL) and `canView` (TS): when `recipient_key = giver_key` and the giver name is hidden for the viewer, the recipient name is hidden too.
- Proof: "FIXED F8" in `review_findings.test.sql` (also through `can_view`, and visible again when the giver name is visible); `visibility.test.ts`.

## F9 Size limits and key stripping (fixed)
- Changed: `validate_answers` is now a wrapper over the old body (renamed `validate_answers_core`) and raises `too_long` for text or "other" over 10000 characters and `giver_comment` over 2000. `write_answers` stores `canonical_answer(type, answer)` (only the known keys of the type). `lib/validation.ts` has the same limits (`LIMITS.answerText`, `LIMITS.giverComment`).
- Proof: "FIXED F9" (10001 and 2001 rejected, exactly 10000 and 2000 accepted, unknown key not stored); `validation.test.ts`.

## F10 session_course (fixed)
- The web app does not call it, but RLS policies do (evaluated as the caller), so it cannot be revoked. It now returns null unless the caller has `read` on the session's course; calls without a JWT (cron, service role, owner) are unchanged.
- Proof: "FIXED F10" (stranger gets null, a member gets the course id).

## F11 Wiring (fixed)
- `_shared/due.ts` `studentSubmitDeadline` is `max(extension, closes_at + grace)`; test in `due.test.ts`. `buildRosterCsv` neutralises formulas (`review.csv.test.ts`). `studentTypes.ts` comment fixed. `AuthContext` claim promise has a rejection handler and always sets `claimedFor`. `EmailStatus` type has `pending`.

## F12 Operations (partly fixed)
- `.github/workflows/deploy-supabase.yml`: new `test` job (installs `postgresql-16` and the client when missing, runs `bash supabase/tests/run.sh`); `deploy` has `needs: test`. Not run on GitHub.
- `docs/DEPLOY.md` step 7 says which key goes into the `service_role_key` secret.
- Known limits, no code: the four anon `student_*` RPCs have no throttle (use Supabase's API rate limits; `student_get_results` is CPU heavy on big sessions); results can be published while a session is open; `send-reminder` has no per-instructor rate limit; team renames leave team-keyed responses in place; DEPLOY.md does not mention minimum password length or leaked-password protection.
- Left open: `supabase/setup-cli` is still `version: latest` (pin it once you know which version works).

## Re-check findings R1 to R3 (migration `20261116000011_recheck_fixes.sql`)

### R1 CONTRIB probe by resubmitting (fixed)
- Changed: `student_get_results` returns a CONTRIB question's numbers only when `now() >= greatest(closes_at + grace, latest deadline extension in the session)`. Before that the question comes back with `responses: []` and `contrib_available_after` (that timestamp) and no `my_claim` or `team_view_of_me`. Submission is not blocked. `StudentResults` says when the summary appears (course time zone). `contribAvailableAfter()` in `web/src/lib/time.ts` mirrors the rule (test in `time.test.ts`). Other question types are unchanged. Existing tests that read CONTRIB numbers now use a closed session.
- Proof: `review_recheck.test.sql` "FIXED R1" (no numbers while open, the time equals closes_at + grace, the latest extension moves it, numbers appear after the close).

### R2, R3 Team moves and renames (fixed, with one deviation to know about)
- Changed: `responses` gets `giver_team_key`, `recipient_team_key` (null for instructors and `none`) and `giver_team_ids`, `recipient_team_ids` (the members of those teams at write time). A BEFORE INSERT trigger fills all four on every write path (student_submit, instructor_submit, instructor_moderate, direct inserts); existing rows are backfilled from the current teams. The checks for `giver_team_members`, `recipient_team_members` and team recipients (including "recipient is the viewer's team" and `recipient_is_me`) now test whether the viewer is in the stored member list. `viewer_qualifies` and `can_view_keys` have new signatures; `can_view` and `student_get_results` use them.
- Deviation from the brief: comparing the viewer's current team KEY with the stored key would not fix R3, because a team recipient key is the label itself (rename T4 to T3 and the new T3 matches the old key). So the stored member ids decide, and the keys are stored for reporting. Consequence: a student who joins a team after a response was written does NOT see that team's earlier responses (giver-team lists or team-addressed). The effect the brief expected (late joiners see earlier team responses) therefore does not occur; the cost is that a late joiner also misses feedback addressed to the team. A giver who edits an answer re-stamps that row with the then-current teams.
- UI: editing a student's team or section, when the student has responses, shows a notice; the enroll preview marks and lists existing students whose team or section would change.
- Proof: `review_recheck.test.sql` "FIXED R2" (moved Dave sees nothing, stored teams checked) and "FIXED R3" (relabelled T4 does not read T3 feedback).

### Also
- `docs/DEPLOY.md`: reset links must be opened in the same browser (PKCE). `deploy-supabase.yml`: `supabase/setup-cli` pinned to 3.2.0.
