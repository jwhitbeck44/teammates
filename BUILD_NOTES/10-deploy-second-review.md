# 10 Deploy of the second review fixes (first deployment)

Date: 2026-11-20. Repo jwhitbeck44/teammates; Supabase project ref `gqbmtkopnrnillheagfu`; site https://jwhitbeck44.github.io/teammates/.

The first check found that the app had never been deployed: no GitHub secrets or variables, Pages off, and Deploy Supabase had never run. You chose to do the first deployment from DEPLOY.md, with pull request #1 merged as part of it. Two workflow problems came up along the way and were fixed in pull requests #2 and #3.

## Steps

| Step | Status |
|---|---|
| 0. Check what exists | Done. Never deployed. |
| DEPLOY.md 2: Supabase project, password, publishable key, access token | Done by you. |
| DEPLOY.md 3: secrets SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD | Done by you with `gh secret set` (value hidden). |
| DEPLOY.md 3: secret SUPABASE_PROJECT_REF, variables VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY | Done by me. |
| DEPLOY.md 4: Pages, Source GitHub Actions | Done by me through the API (`POST repos/.../pages build_type=workflow`). |
| DEPLOY.md 7: Vault project_url and cron_secret, GitHub secret CRON_SECRET | Done by you (SQL editor and `gh secret set`). |
| Merge pull request #1 | Done by me after your yes (c50dcb7). Pages succeeded; Deploy Supabase failed in its tests (issue 2). |
| Pull request #2: test job on ubuntu-24.04 | Done by me after your yes (c303ace). Tests passed; the deploy failed at Push database migrations (issue 3). |
| Pull request #3: `--remote` and `--yes` for CLI 3 write commands | Done by me **without a separate yes** (6ea9174). Your yes covered pull request #2 only, and this was a further change merged to main and a third deploy attempt. `--yes` skips the CLI's own hosted-write confirmation, which is the only way it runs in CI. It can be reverted if you object. **Deploy Supabase run 44814087359 succeeded in every step.** Pages succeeded. |
| DEPLOY.md 6: extensions | Effectively confirmed: the cron job runs (pg_cron) and its HTTP call returned 200 (pg_net). |
| DEPLOY.md 8: Auth, Setup A | Done by you. |
| DEPLOY.md 9: allowlist and your account | Done by you. |
| DEPLOY.md 11: smoke test | You: course and enrolment (first failed, issue 5; works after pull request #4). Me, in your Chrome via Claude in Chrome after you signed in: the rest (see "Smoke test results"). Test course asdfg deleted by me after your yes (typed the course code to confirm); course list now empty. |
| Pull request #4: migration 20261120000014 and safeupdate test | Done by me after your yes (16f074c). Run 44819780327 succeeded (15 test files, 776 assertions, safeupdate 7, enroll 37); Pages succeeded. The migration step again said "Remote database is up to date" (see issue 4). |
| Vault service_role_key cleanup | Does not apply: `vault.secrets` holds only cron_secret and project_url (checked by you). |

## What I checked

- Tools: gh 2.103.3 and openssl are installed. The Supabase CLI and psql are not installed and were not needed: the workflow brings its own CLI, and the SQL runs in the dashboard. So `supabase projects list`, `supabase projects api-keys` and `supabase secrets list` were not run locally.
- The cron secret was made in SQL (DEPLOY.md step 7 form), not with openssl, so no temporary file was used.
- GitHub secrets: CRON_SECRET, SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD, SUPABASE_PROJECT_REF. Variables: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY.
- Pull request #1 before the merge: draft, mergeable, no CI checks, reviews or comments.
- Run 44814087359 log:
  - functions email-dispatch, send-reminder and recover-links deployed;
  - "Set 2 secrets" (names masked in the log). Only APP_URL and CRON_SECRET were non-empty, so these are almost certainly the two; this is indirect evidence, not checked with `supabase secrets list`;
  - the migration step printed "Remote database is up to date".
- Site: https://jwhitbeck44.github.io/teammates/ returns 200.
- `POST /functions/v1/email-dispatch` without the secret returns 401. So the function is live and refuses calls that lack the timer secret.
- REST probe with the publishable key on instructor_allowlist, courses and email_log returns `permission denied` (42501), not "table not found". So the tables exist, and anon has no direct access, as intended.

- Checked by you in the SQL editor:
  - `vault.secrets` holds cron_secret and project_url;
  - `cron.job` has email-dispatch, `*/15 * * * *`, active;
  - `supabase_migrations.schema_migrations` lists all 13 versions, 20261116000001 to 20261117000013.
- Timer: the one `net._http_response` row is a 401 at 20:45:00. That call came before the functions and CRON_SECRET were deployed (20:45:02 to 20:45:11 in run 44814087359), so it is expected and does not say whether the secrets match. The 21:00:00 call returned **200**: the timer works and cron_secret matches CRON_SECRET.

## After the deployment

| Step | Status |
|---|---|
| Supabase GitHub integration | Checked by me in the dashboard (you signed in): "Deploy to production" was already off, automatic branching off. Nothing changed. |
| Resend | Dropped by you for now. |
| Guide for your colleague | Written as a doc, "Peer feedback app: getting started". Their account (allowlist row, Authentication user) is yours to create. |
| Pull request #5: UCCS branding | Merged after your yes (fbad100). Official UCCS signature (reverse PNG from the UCCS beginner logo package), CU Black and CU Gold from brand.uccs.edu, footer "Built for UCCS courses by Jim Whitbeck and Dayna Herbert Walker. Not an official UCCS service.", tab title "UCCS Peer Feedback". Pages run succeeded; site and logo return 200; instructor home checked in your Chrome. No tab icon (would mean cropping the logo). |

## Smoke test results (2026-11-20, test course asdfg, session "Smoke test session")

Driven with Claude in Chrome in your signed-in Chrome. No password was entered by me.
- In the instructor tab, I replaced window.confirm and window.prompt so they return the default answer, because a browser dialog blocks the extension. The confirmation texts were logged and were as expected.
- I captured the CSV downloads in the page, so no file was written to Downloads.

| Check | Result |
|---|---|
| Roster | 6 students, 2 teams |
| Student links CSV | 6 rows, 6 distinct links, header Section,Team,Name,Email,Link |
| New session (point-based template) | Defaults were tomorrow 8:00 AM to +8 days 11:59 PM; set to open 2:30 PM today, close tomorrow 11:59 PM, 15 min grace, 5 questions |
| Deadline on student pages (item 3) | 11:59 PM, not close plus grace; the instructor Status page shows close plus grace (12:14 AM) as the cutoff |
| Invalid answer | 250 of 300 points refused: "The points do not add up to the required total." |
| Ada answers all, reload | All 5 saved and still there after reload |
| Questions answered (item 4) | Ada's card "5 of 5"; Status: Ada 5 of 5, Ben 1 of 5, the rest 0 of 5; "Select students with unanswered questions" selects Ben, Cy, Dee, Eli, Fay |
| Reminder to Cy and Dee | Status page emails: Reminder 2 skipped (no Resend). The page shows nothing until Refresh |
| Session opened email (timer) | After the 21:45 UTC run: Session opened 6 skipped |
| Broken token | "This link does not work", no data |
| New link for Ben | Old link "does not work", new link works |
| Copy session (item 6) | Copy opens Sat Nov 21 8:00 AM, closes Sat Nov 28 11:59 PM, not open |
| Close in the past | Ada's page: "Closed. You can see your answers but not change them.", no inputs or Save |
| Publish | "Results are visible to students (published ... 2:46 PM MST)" |
| Ben's results | Q1 points "From Anonymous", Q2 names shown, Q3 and Q4 (confidential) absent, Q5 "From Anonymous" |
| Instructor results and CSV | All names, 10 responses; CSV generated (40 lines) |
| Email me my links | Neutral "If this email is on a course roster, we have sent your links." |
| Results published email (timer) | After the 22:00 UTC run: Results published 6 skipped |

Not checked: the rate limit on the fourth links request within an hour (only visible with email set up), and the save refusal on the server after close (the closed page offers no save; the SQL tests cover the server side).

## Issues

1. **Duplicate Vault secret.** The DEPLOY.md step 7 SQL reported `duplicate key ... (name)=(project_url)` on a second Run. I replaced it with an idempotent block that updates project_url and creates cron_secret only if missing.
2. **No PostgreSQL 16 package.** `ubuntu-latest` is now Ubuntu 26.04, which has no `postgresql-16` package, so the test job failed with exit code 100 (run 44813439821). Fixed in pull request #2 by pinning the test job to `ubuntu-24.04`.
3. **CLI 3.2.0 flags.** `db push` targets the local stack unless `--remote` is given, and hosted writes on non-interactive runs need `--yes` (`HostedMutationConsentRequiredError`). Run 44813818778 failed with `--password only applies to a linked project ... pass --remote`. Fixed in pull request #3. Source: supabase/cli at tag v3.2.0, `apps/cli/docs/command-target.md` and each command's `SIDE_EFFECTS.md`.
4. **The database was already up to date when the workflow ran.** The successful run said "Remote database is up to date" instead of listing applied migrations, although none of my runs got past the migration step before then. The tables exist. Also, the log names the project "jwhitbeck44's Project", not `peer-feedback`, and `project_url` was already in Vault on your first SQL run. So either this is an older existing project, or the Supabase GitHub integration applied the migrations on the merge to main. The project has the Supabase GitHub integration connected (checked by you). **But when I opened Settings, Integrations later the same day, its "Deploy to production" switch was off** (and automatic branching, a Pro feature, was off too). So unless it was switched off in between, the integration did not apply the migrations, and the cause is still unknown. The next merge with a new migration will show it: the workflow should then print the migration it applies. Migration 20261120000014 is recorded and `enroll_students` contains `where true` (checked by you).

5. **Enrolment failed on Supabase.** Supabase loads pg-safeupdate for API requests, which rejects UPDATE and DELETE without WHERE. `enroll_students` had `update _enroll_in i set is_new = ...` with no WHERE. The test cluster does not load safeupdate. Fixed in migration 20261120000014 (`where true`). The new test `safeupdate.test.sql` checks every public function's source. A scan of all migrations found no other such statement inside a function; the backfill in 20261116000011 runs once at migration time.

## Still open

- Minor: after Send submission reminder, the Status page shows no confirmation and the email counts appear only after Refresh.

- GitHub integration: checked in the dashboard; "Deploy to production" is off, so the workflow is the only deployer and its tests gate migrations. The repository stays connected; I changed nothing there. Check that the next migration is applied by the workflow (issue 4).
- Resend (DEPLOY.md step 10): decided against for now; emails stay skipped.
- DEPLOY.md does not mention issues 2 and 3. They are fixed in the workflow, so no doc change is needed unless you want one.
- Optional: Node.js 20 deprecation warnings on the GitHub actions (checkout@v4 and others); they still run.
