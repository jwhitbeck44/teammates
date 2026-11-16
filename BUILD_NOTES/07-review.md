# 07 Independent review

Reviewer did not write this code. Scope: ARCHITECTURE.md, all BUILD_NOTES, all migrations, the three Edge Functions, `web/src/api`, `web/src/auth`, the CSV code, DEPLOY.md step 8. Nothing outside the files listed below was changed.

Review tests (all pass today; the "FINDING" assertions assert the current, vulnerable behaviour, so each must be inverted when its finding is fixed):

- `supabase/tests/review_findings.test.sql` (20 assertions, findings F1 to F10)
- `supabase/tests/review_coverage.test.sql` (35 assertions, things that were checked and held)
- `web/src/lib/review.csv.test.ts` (3 tests)

Run: `bash supabase/tests/run.sh review_` and `cd web && npx vitest run src/lib/review.csv.test.ts`. The existing suite (602 assertions, 333 web tests) passed before the review files were added.

Bottom line: the design holds up well. Anon is locked down, every SECURITY DEFINER function pins `search_path`, cross-course access is blocked everywhere I tried, and `student_get_results` hides giver names correctly for all seven presets and for team recipients. The two things I would not deploy without fixing are F1 and F2.

---

## Findings, most severe first

### F1. HIGH: one student can break results for her whole team and the instructor CONTRIB page for the whole course

- Where: `supabase/migrations/20261116000003_functions.sql:350` (validate_answers accepts the value) and `:683` (`(r.answer ->> 'value')::int`); `20261116000002_rls.sql:47-49` (`jb_is_int` is true for `100.0`).
- Failure: Alice calls `student_submit` directly (public RPC, only her token needed) with a contrib answer `{"value":100.0}`. `jb_is_int` accepts it because `100.0 = trunc(100.0)`. jsonb stores the text `100.0`. Later `contrib_team_result` runs `'100.0'::int` and raises `22P02 invalid input syntax for type integer`. Effects: `student_get_results` raises for every student in Alice's team for the whole session (all questions, not only the contrib one), and `instructor_contrib_results` raises for the whole course because it loops over every team. The web form sends `100`, so this only happens with a hand-built request, but any student can do it, and it can be timed for the moment grades are being assigned.
- Proved: yes. `review_findings.test.sql`: "FINDING F1: validate_answers accepts contrib value 100.0", "Bob's entire results page now raises ...", "instructor CONTRIB results fail for the WHOLE course". Control: a student in another team is unaffected.
- Smallest fix: line 683, `(r.answer ->> 'value')::numeric::int`. Better as well: in `write_answers` store `jsonb_set(a -> 'answer', ...)` only after canonicalising, or have `validate_answers` reject non-canonical numbers (`(v -> 'value')::text ~ '^-?[0-9]+$'`). Also make the loop in `instructor_contrib_results` and `student_get_results` robust (a bad team should not blank the course).

### F2. HIGH: observers and tutors can read every student's `access_token` and then act as the student

- Where: `supabase/migrations/20261116000006_grants.sql:18-20` (table-level `select` on `students`), `20261116000002_rls.sql:40-41` (`students_select` uses `has_perm(..., 'read')`, true for any linked instructor), `web/src/api/instructor.ts:183-187` (`listStudents` does `select('*')`).
- Failure: an observer (read-only role) runs `select access_token from students` through PostgREST, then calls `student_submit` as anon with that token. The ratings are stored as a normal student submission (`updated_by = 'student'`), so nothing shows that an observer wrote them. The same token opens `student_get_results` as that student. Ratings feed grades, and the architecture table says observers cannot write.
- Proved: yes. `review_findings.test.sql`: "an observer can SELECT Alice's access_token", "the observer's copy of the token writes a response as Alice", "a tutor can read all 10 tokens too".
- Smallest fix: replace the table-level `select` on `students` by a column list that leaves out `access_token`, and add one RPC `instructor_student_links(p_course)` that checks `has_perm(p_course, 'modify_students')` and returns `{id, access_token}`. In the UI, `listStudents` must name its columns (`select *` will fail once a column is withheld) and the links CSV and per-student link buttons call the RPC. `regenerate_student_token` already requires `modify_students`.

### F3. MEDIUM: visibility lists can be changed after students answered, which de-anonymises already-collected answers

- Where: `supabase/migrations/20261116000006_grants.sql:40-43` (update on `show_*`), `20261116000002_rls.sql:64-66` (`questions_update`), `:503-507` (only deletes responses when type, path or details change, not when visibility changes).
- Failure: a manager (or coowner, or a UI mistake when switching presets) sets `show_giver_name_to = {recipient, instructors}` on a question that already has responses, or on a published session. Students then see names for answers they gave when the promise was "anonymous to the recipient". Instructors already see names by design, so this is about the promise to students, not about instructors.
- Proved: yes. "FINDING F3: a manager flips the giver-name list on a live, published question" and "the promised anonymity is gone for already-submitted answers".
- Smallest fix: in `validate_question()`, when `tg_op = 'UPDATE'` and any of the three lists changed and the question has responses, raise `visibility_locked` (allow it for questions without responses). Add the code to `errors.ts`. Moving a student between teams after answers exist has the same kind of effect on `giver_team_members` and `recipient_team_members` lists; mention it in the instructor guide or block `team` changes once responses exist.

### F4. MEDIUM: CONTRIB "team view" numbers let a student solve her teammates' individual ratings in a 3-person team

- Where: `supabase/migrations/20261116000004_student_rpcs.sql:171-179` (`team_view_of_me.others`) and `:214-216`.
- Failure: `student_get_results` returns, for a student, the team's average perceived contribution for herself and for every teammate (`own`, `others`). Each average is over the other givers, and the student knows her own ratings, so she can solve for the rest. Team T1 (Alice, Bob, Carol): Carol rates Alice 50 and Bob 150, everyone else rates 100. Alice sees own 75 and others [125, 100]. Since 125 = (Alice to Bob 100 + Carol to Bob x) / 2, x = 150: Alice learns Carol's individual rating of Bob, and from 75 she learns that Bob and Carol's ratings of her are 50 and 100 (which one is which stays ambiguous only when her own ratings are symmetric). With two teammates this is fully determined, with larger teams it narrows. No raw rating is returned, but the individual numbers are recoverable. This mirrors TEAMMATES, but this project promises that CONTRIB individual ratings stay hidden.
- Proved: yes. "FINDING F4: Alice sees team view own=75, others=[125,100]" and "Carol's individual rating of Bob (150) is recoverable by Alice".
- Smallest fix: return only `my_claim` and `team_view_of_me.own`; drop `team_view_of_me.others` (the TS summary already lets the UI omit it). For teams of 3 or fewer, also consider hiding `own` (with 2 members it is the single teammate's rating of her by definition).

### F5. MEDIUM: recover-links can be used to mail-bomb an enrolled student, and its response time reveals whether an address is enrolled

- Where: `supabase/functions/recover-links/index.ts:29-31` (rate limit read), `:47-49` (send, then log), `:51` (answer after sending), `supabase/functions/_shared/send.ts:36-55`.
- Failure (a): the limit of 3 per hour is read from `email_log` before the send, and the log row is written after the Resend call returns. 100 parallel requests for the same address all read zero rows and all send. (b): `ok()` is returned only after `sendAll` finishes (Resend call plus the 600 ms pacing). An enrolled address with a session in the last 180 days answers in several hundred ms to seconds, an unknown address answers in tens of ms, so the endpoint is an enrolment oracle despite the constant body. (c): no per-IP or global cap, so an attacker who knows or guesses roster addresses can burn the Resend quota and the sending domain's reputation.
- Proved: no (needs a deployed function and Resend); read from the code.
- Smallest fix: insert the `email_log` row (status `skipped` or a new `queued`) before sending, with a partial unique index or an `insert ... where (select count(*) ...) < 3` so concurrent calls cannot all pass; return `{ok:true}` before the send using `EdgeRuntime.waitUntil(...)`; add a global cap (for example 60 recovery mails per hour across all addresses, counted in `email_log`).

### F6. MEDIUM, needs a live check: with "Confirm email" off (DEPLOY.md Setup A), a signed-in instructor may be able to change her email and inherit an allowlist entry or an invite

- Where: `docs/DEPLOY.md` step 8 Setup A, `20261116000005_instructor_rpcs.sql:12-25` (`claim_instructor_invites`), `20261116000002_rls.sql:40-44` (`can_create_course` trusts the JWT email).
- Failure: Setup A sets `mailer_autoconfirm` on. I believe GoTrue then applies `updateUser({email})` without any confirmation (I could not confirm this from the docs available to me, so treat it as unverified). A low-privilege instructor (for example a tutor created by the deployer) could change her email to an allowlisted address (gains course creation) or to the address of a person who has a pending, unclaimed coowner invite (gains that course). The code only checks that `email_confirmed_at` is not null, which stays true.
- Proved: no. Cannot be tested without GoTrue.
- Smallest fix: check on a real project first. If it holds, add to DEPLOY.md that Setup A also needs "Secure email change" on and email sending working, or claim invites and allowlist entries only through `auth.identities` rows whose `identity_data->>'email'` matches the confirmed address, or disable email change with a BEFORE UPDATE trigger on `auth.users` that blocks changes to `email`.
- Judgement on step 8: the doc's own warning (sign-up on plus confirm off is unsafe) is right. Setup A (sign-up off, instructors created by the deployer) is safe against outsiders. Setup B (sign-up on, confirm on) is safe if email really works. The remaining gap is the one above, and a short note that the Supabase built-in mailer's low limits can silently make Setup B fail.

### F7. MEDIUM, unverified: password-recovery flow can miss the `PASSWORD_RECOVERY` event

- Where: `web/src/api/client.ts:9` (client created at import), `web/src/auth/AuthContext.tsx:38-45` (subscription added in a `useEffect`).
- Failure: with `HashRouter` the recovery link lands on `#access_token=...&type=recovery`. supabase-js reads it when the client is created (before React mounts) and emits `PASSWORD_RECOVERY` from a timer. If the event fires before `AuthProvider` subscribes, `recovering` stays false and the user is silently signed in without being asked for a new password, so the reset never completes. Not an exposure (the user proved control of the mailbox), but the flow is likely flaky.
- Proved: no (needs a browser and a real project).
- Smallest fix: in `client.ts`, check `location.hash` for `type=recovery` before `createClient` and keep that in a module-level flag that `AuthProvider` reads on mount.

### F8. LOW: a hidden giver is revealed when the recipient is the giver

- Where: `20261116000003_functions.sql:458-462` (`can_view_keys`), `web/src/components/instructor/questions/VisibilityEditor.tsx`.
- Failure: question with recipient type `self` (or any list that contains the giver, such as `students`), giver names hidden, recipient names visible to `students`: Dave sees `Anonymous > Bob: my secret`, so Bob wrote it. Only reachable through the custom checkbox grid, none of the four presets.
- Proved: yes. "FINDING F8: giver is hidden but the recipient name (Bob) is shown".
- Smallest fix: in the editor, warn (or reject in `validate_question`) when `recipient_type` is `self`, or when it allows self rows, and the giver-name list is narrower than the recipient-name list.

### F9. LOW: no size limits and no key stripping on stored answers

- Where: `20261116000004_student_rpcs.sql:21-36` (`write_answers`), `20261116000003_functions.sql:262-270` (text answers), `giver_comment` unchecked.
- Failure: any token holder can store a 3 MB text and a 3 MB `giver_comment` per recipient row, or arbitrary extra keys inside `answer` (`{"text":"ok","hidden":{...}}`). Extra keys are returned to viewers in `student_get_results` and to instructors. Storage abuse, not a leak.
- Proved: yes. "FINDING F9" in `review_findings.test.sql`.
- Smallest fix: in `validate_answers` reject `length(text) > 5000` and `length(giver_comment) > 2000`, and have `write_answers` rebuild `answer` from the known keys per type (or reject unknown keys with `invalid_answer`).

### F10. LOW: `session_course(uuid)` is callable by every signed-in user

- Where: `20261116000006_grants.sql:49`.
- Failure: any account can map a session id to its course id. Ids are random uuids, so this needs a leaked id. Needed by RLS policies, so it cannot simply be revoked.
- Proved: yes ("FINDING F10").
- Smallest fix: none needed beyond noting it; or make it return null unless `has_perm(course, 'read')` (cheap, same answer for allowed callers).

### F11. LOW: wiring and consistency mismatches

1. `supabase/functions/_shared/due.ts:60-62` (`studentSubmitDeadline`) still uses the old rule "extension replaces `closes_at + grace`". SQL `student_deadline` and `web/src/lib/time.ts:156-159` use `greatest(extension, closes_at + grace)` (lead decision of 2026-11-16). Effect: `planReminders` (`due.ts:283`) skips ("ignored") a student whose extension is shorter than the grace period while the database still lets her submit. Fix: `Math.max(t(ext.closes_at), t(s.closes_at) + grace)`; update `due.test.ts`.
2. `web/src/lib/csv.ts:245-249` `buildRosterCsv` does not neutralise formula cells (the other three CSV builders do). It is not called by any page today, so nothing is exposed; neutralise it, or delete it, before someone wires it to a button.
3. `web/src/lib/studentTypes.ts:55` still says the three visibility lists are "not returned by student_get_session yet". Migration 08 returns them. Stale comment only.
4. `web/src/api/instructor.ts:183-187` selects `*` from `students` (see F2; it must change as part of that fix).
5. `web/src/auth/AuthContext.tsx:58-62`: if the `claim_instructor_invites` promise rejects (network), `claimedFor` is never set and `RequireAuth` shows "Loading..." forever. Add a `.catch` / `.finally`.

No other mismatch found (see the checked list for what was compared).

### F12. LOW: operations and hardening

- `student_*` RPCs are open to anyone with no throttle. `student_get_results` is CPU heavy on big sessions (a plpgsql visibility check per response row), so a student reloading in a loop can load the database. Add Supabase's API rate limits and consider caching or a set-based `can_view`.
- Results can be published while the session is still open (`publish_session` only requires `opens_at <= now()`, and `at_open` shows results from the start); students can then read feedback about themselves and still edit what they gave. By design in TEAMMATES, worth a line in the instructor guide.
- `email-dispatch` compares the bearer with `SUPABASE_SERVICE_ROLE_KEY`. If the deployer pastes a new-style `sb_secret_...` key into Vault (DEPLOY.md step 7) it will not equal the function's environment value and every cron call returns 401, silently. Say in DEPLOY.md which key form to paste.
- `send-reminder` has no per-instructor rate limit (200 students per call, unlimited calls). Instructor-only, so a nuisance risk.
- `.github/workflows/deploy-supabase.yml` runs `supabase db push` on every push to main with no step that runs `supabase/tests/run.sh`, and uses `supabase/setup-cli` `version: latest`. Gate the push on the SQL tests and pin the CLI.
- DEPLOY.md does not mention a minimum password length (the app enforces 8 only on reset) or leaked-password protection.
- Team rename leaves team-keyed responses (`t:old|name`) in place; if another team later gets the old name, the responses attach to it (noted by the database author, `BUILD_NOTES/01-database.md`). Block renames once responses exist, or rewrite the keys.

---

## Checked and found fine

Anonymity (A)
- `student_get_results` for all presets in section 7 (1 to 4 plus two custom lists) and for team recipients (`teams`, `own_team`, `recipient_team_members`): hidden names are `Anonymous`, no keys, ids, or emails are returned (existing `results.test.sql`, re-read; I added no weaker cases).
- Row order: sorted by displayed recipient name, then displayed giver name, then `random()`. Rows with hidden givers cannot be told apart by position. The group split (about you, you gave, others) uses only `is_own` and `recipient_is_me`.
- CONTRIB: individual rows are never returned (`responses: []`), and only when `recipient` is in the response list.
- `student_get_session` and `student_portal`: only the caller's own answers and own email; recipients list carries names, `s:<uuid>` keys and team keys of the roster (needed to answer, not secret); no other student's answers.
- Error messages: instructor RPCs answer `forbidden` for missing rows and missing permission alike; student RPCs answer `invalid_token` or `not_found`; `not_a_recipient` echoes only the caller's own input.
- No timing difference of note on the student RPCs (CASE short-circuits name lookups).

Access (B)
- anon: no table or column privilege, no PUBLIC execute; the only functions anon may execute are the four `student_*` (`review_coverage.test.sql` and `security.test.sql`). `authenticated` may execute exactly 20 functions (listed and asserted).
- Every SECURITY DEFINER function pins `search_path = public, pg_temp` (or `public, extensions, pg_temp`), `pg_temp` last (asserted).
- `student_submit`: giver comes from the token only; recipient must be in the resolved list (other team, self on a non-self path, other course, team key on a student path: all `not_a_recipient`); duplicates rejected; not open, after grace, and extension cases correct (a pointless short extension neither reopens nor shortens); a question or session of another course gives `not_found`.
- Fuzz: 71 malformed answers across all 10 question types plus 9 malformed bodies all fail with a plain code (SQLSTATE P0001), none with an internal Postgres error. (The one hole the fuzz does not cover is F1, which passes validation.)
- Column grants: clients cannot write `access_token`, `published_at`, the three email stamps, `user_id`, instructor `email` after creation, `course_id` or `session_id` columns, `courses.created_by`, `responses`, `email_log`, or the allowlist. Extensions cannot be re-pointed at another course's student or session; a question cannot be moved to another session.
- Instructor of course A versus B: select, insert, update, delete and every RPC refused (existing tests plus mine for extensions, questions, forged `user_id`, forged `created_by`, session created already published, student created with a chosen token). Roster import writes only to the course in the argument.
- Observer and tutor cannot write through tables or instructor RPCs; a manager cannot promote herself, invite a coowner, or remove a coowner; last-coowner trigger works.
- `has_perm` and every RPC check permission before acting; ids cannot be probed.

Auth (C)
- `claim_instructor_invites` uses `auth.users.email` and requires `email_confirmed_at`, not the client JWT; a second call claims nothing; anon cannot call it. Allowlist is not readable or writable by clients. Nothing trusts a client-supplied email or role (roles come from `course_instructors` through `auth.uid()`).
- Password reset uses `redirectTo = origin + pathname`, which DEPLOY.md step 8 tells the deployer to allow-list.

Edge Functions (D)
- `email-dispatch`: 401 unless the bearer equals the service-role key (constant-time compare).
- `send-reminder`: verifies the JWT with Auth, calls `has_perm(course_of_session, 'modify_sessions')` as the caller, loads students filtered by `course_id` and the id list (so another course's student ids are ignored), checks session state, 403 for unknown session and for no permission alike. The copy goes to the caller's own address.
- `recover-links`: sends only to the address that matches a roster row (not a mail relay for arbitrary recipients), always `{ok:true}`, never returns or logs tokens. The enrolment-oracle and burst problems are F5.
- Secrets: `RESEND_API_KEY` and the service key are read from the environment, never logged or returned; Resend error text is truncated before it is stored. Email templates escape all instructor and student text in HTML.

Wiring (E)
- Every RPC call in `web/src/api/*.ts` and `AuthContext.tsx` matches the SQL name, argument names (`p_token`, `p_session`, `p_question`, `p_answers`, `p_student`, `p_course`, `p_rows`, `p_new_name`, `p_target_course`) and the JSON keys the code reads.
- Every `supabase.from(...)` call is in `api/instructor.ts`; insert and update column lists match the column grants (courses, course_instructors, students, sessions, questions, deadline_extensions); `insert ... returning` works because `courses_select` includes `created_by = auth.uid()`; the extension upsert has insert and update privilege and policies.
- All error codes raised in the migrations exist in `web/src/lib/errors.ts` (checked by script).
- The Edge Functions' selects (`students`, `sessions`, `courses`, `questions`, `responses`, `deadline_extensions`, `email_log`) match the schema, and `has_perm` is executable by `authenticated`.

CSV (F)
- `review.csv.test.ts`: with hostile names, teams, briefs, options, answers, "other" text and comments, no cell of the results CSV (all 10 types, with statistics), the links CSV or the non-submitter CSV starts like a formula. Roster import is a client-side parse followed by `enroll_students(p_course, ...)`, which is permission-checked and course-scoped (a hostile `course_id` key in a row is ignored).

Not covered (needs a live project): PostgREST role switching, Vault and `pg_net` argument names, GoTrue email-change behaviour (F6), the recovery-link flow in a browser (F7), the real Resend send path and its timing (F5).

---

## Re-check of fixes (commit 32ad274)

Suites run on the fixed tree: `bash supabase/tests/run.sh` 12 files, 695 assertions, all pass (before my new file); `cd web && npx vitest run` 17 files, 339 tests, all pass. New proof file: `supabase/tests/review_recheck.test.sql` (20 assertions; "FINDING R*" lines assert behaviour that still exists).

| Finding | Verdict | Notes |
|---|---|---|
| F1 | OK | `jb_is_int` now requires `^-?[0-9]{1,15}$`; `100.0`/`100.5` rejected; `contrib_team_result` tolerates any stored junk (non-number counts as not submitted, clamped). Complete. |
| F2 | OK | Column-level select without `access_token`, `select *` and `select access_token` give 42501 for managers too, links only via `instructor_student_links` (modify_students). Update, delete and named-column select still work (R5). No other web path reads the token. |
| F3 | OK for its scope | `visibility_locked` blocks adding entries to any of the three lists once responses exist; narrowing, renumbering and re-adding checks behave as intended (R4); trigger order is correct (type/path/details change deletes responses first, then the lock sees none). Remove-then-re-add across calls is blocked. See R2/R3 for the gap it does not cover. |
| F4 | NOT OK (new finding R1 below) | `others` is gone, but the leak can be re-opened by editing. |
| F5 | OK, unverified live | Slot is claimed under an advisory lock before sending; limits per address and global are counted over all statuses. Residual: the 200/hour global cap lets an attacker who knows about 67 enrolled addresses block legitimate recovery for an hour (low); if `EdgeRuntime.waitUntil` is absent the function awaits and the timing difference returns (documented). Only enrolled addresses consume slots, so no extra DB write is a signal. |
| F6 | OK (documented) | DEPLOY.md only; still unverifiable without GoTrue. |
| F7 | OK in code, unverified | PKCE plus import-time subscription removes the race. Caveat: PKCE needs the browser that requested the reset (code verifier in local storage); opening the email link on another device fails. Same applies to sign-up confirmation links in Setup B (the address is still confirmed; the user signs in by password). Add one sentence to DEPLOY.md. |
| F8 | OK | Recipient name hidden when recipient equals giver and giver name hidden; no new inference found (the self row shows as Anonymous, the other rows are unlinkable). |
| F9 | OK | Wrapper checks 10000 / 2000, `canonical_answer` strips unknown keys; renamed `validate_answers_core` kept its ACL (execute lists asserted by the existing coverage test). |
| F10 | OK | `session_course` null without `read`; RLS policies unaffected (all suites pass). |
| F11 | OK | |
| F12 | OK (partial, as stated) | CLI still `latest`. |

### New findings

- **R1, MEDIUM, proved: F4 is re-opened by resubmission.** `team_view_of_me.own` is scaled by the sum of the student's own claims over the teammates she rated. While results are visible and the session still accepts answers (published while open, `at_open`, or grace), Alice can resubmit with a subset of teammates and read how `own` changes. Team T1 from the F4 test: full submission gives own 75, rating only herself (100) and Bob (200) gives 113, from which `75*300/113 - 75 = 124 (125 within rounding)` is Bob's team average, so Carol's rating of Bob is again `2*125 - 100`. Test: "FINDING R1" (both assertions). Smallest fix: make `student_submit` (and `instructor_submit`) refuse once `session_is_published(s)` is true (raise `already_published`), or return `team_view_of_me` only after the student's deadline has passed. Either closes it because the probe needs live editing.
- **R2, MEDIUM, proved: moving a student between teams after answers exist exposes earlier responses and, with name lists that include `giver_team_members`, giver names.** The fixer's open item is real. Visibility is evaluated against current team membership, and a manager `update students set team` or a roster re-import (the normal way to handle a late switch) triggers it. Test: Dave (T2) moved to T1 then sees `Alice>Anonymous:A>B` with Alice named. No student can cause it; it needs an instructor action, but it is silent. Contrib is not exposed (a moved student has no ratings, so his view stays empty).
- **R3, MEDIUM, proved: team rename or relabel hands feedback addressed to a team to whoever now carries the label.** After T3 is renamed T9 and T4 is renamed T3, team T4's members read feedback written for the old T3. Same trigger, same fix.
- **Smallest fix for R2 and R3 (the open item):** in `students_validate`, when `section` or `team` changes (UPDATE) and the student has given or received any response, or any team-keyed response exists for the old team key, raise `team_locked`; in `enroll_students` report it per row. If moves must stay possible, require deleting the affected sessions' responses first, or re-key `t:` recipient keys in the same transaction (rename only) and block moves of students with responses. Until then, document that moving or renaming teams after a session opened changes who can see what.

Judgement on the open item: it can expose hidden givers (R2, when the giver-name list includes `giver_team_members`) and expose feedback to the wrong recipients (R3), but not CONTRIB individual ratings and not to students acting alone.
