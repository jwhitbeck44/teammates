# Deploying the peer feedback app

This guide is for one person with a GitHub account and a web browser. You install nothing on your computer. Everything runs on GitHub (the website and the deploy scripts) and Supabase (the database, sign-in and email functions). Both have free plans that are enough for a few classes.

Menu names in the GitHub and Supabase dashboards change from time to time. Where a menu name is my best recollection and I could not check it, the text says "check in the dashboard". If a name has moved, use the search box in the dashboard.

Time needed: about 45 minutes the first time.

What you will collect along the way (keep a scratch note open):

| Item | Where it comes from | Used for |
|---|---|---|
| Project ref | Supabase | secret `SUPABASE_PROJECT_REF` |
| Project URL | Supabase | variable `VITE_SUPABASE_URL`, Vault secret `project_url` |
| anon (public) key | Supabase | variable `VITE_SUPABASE_ANON_KEY` |
| service_role key | Supabase | Vault secret `service_role_key` (never goes in GitHub, never in the website) |
| Database password | You choose it | secret `SUPABASE_DB_PASSWORD` |
| Personal access token | Supabase | secret `SUPABASE_ACCESS_TOKEN` |
| Pages address | GitHub | Supabase Auth settings |

## 1. Create the GitHub repository from this code

1. Sign in at github.com. Click the **+** at the top right, then **New repository**.
2. Name it, for example `peer-feedback`. The name becomes part of your site address, so keep it short and without spaces.
3. Choose **Public**. GitHub Pages on a free account needs a public repository (check in the dashboard: private repositories can publish Pages only on paid plans). The repository holds code only. Your students' data lives in Supabase, not in GitHub.
4. Do not add a README or license (the project already has them). Click **Create repository**.
5. Upload the code. On the empty repository page click **uploading an existing file**, drag in the contents of the project folder (the folders `.github`, `supabase`, `web`, `docs` and the files at the top level), and click **Commit changes**. Browser upload skips hidden folders on some systems; if `.github` is missing afterwards, see Troubleshooting.
6. Your repository address is `https://github.com/<your-user>/<repo-name>`. Your site will be `https://<your-user>.github.io/<repo-name>/`. Write that down; this is the "Pages address".

## 2. Create the Supabase project

1. Go to supabase.com and sign up (the GitHub sign-in button is easiest).
2. Create an organization if asked, then **New project**.
3. Fill in:
   - Name: `peer-feedback`.
   - **Database password**: click the generate button or make a long one. Copy it into your scratch note now. It is shown only once.
   - Region: the one closest to you.
   - Plan: Free.
4. Wait a couple of minutes until the project is ready.
5. Collect:
   - **Project ref**: the 20 letter code in the project address (`https://supabase.com/dashboard/project/<ref>`), also the part of the project URL before `.supabase.co`.
   - **Project URL** (looks like `https://<ref>.supabase.co`) and the **anon key** and **service_role key**: in the project settings under **API** (check in the dashboard: newer projects may label them "Project URL", "anon public" and "service_role", or show "publishable" and "secret" keys. Either pair works if the app is told which one is which; use the `anon`/`publishable` key for the website and the `service_role`/`secret` key for Vault in step 7).
6. Create a **personal access token**: click your avatar at the top right, then **Account preferences** (check in the dashboard), then **Access Tokens**, then **Generate new token**. Name it `github-deploy`. Copy it now; it is shown once.

Free Supabase projects pause after about a week without activity. If students report errors after a long quiet stretch, open the project in the dashboard and click **Restore** (check in the dashboard).

## 3. Add GitHub secrets and variables

In your GitHub repository: **Settings**, then **Secrets and variables**, then **Actions**.

On the **Secrets** tab, click **New repository secret** for each:

| Name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | the personal access token |
| `SUPABASE_DB_PASSWORD` | the database password |
| `SUPABASE_PROJECT_REF` | the project ref |

Optional secrets (step 10 explains them; skip for now if you do not want email yet): `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`. `APP_URL` is only needed if you use a custom domain; by default the deploy script builds it from your user and repository name.

On the **Variables** tab, click **New repository variable** for each:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | the project URL, for example `https://abcdefghij.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the anon (public) key |

The anon key is meant to be public; it is baked into the website. The base path (`/<repo-name>/`) is set by the workflow itself, so you do not create `VITE_BASE_PATH` unless you use a custom domain at the root (then set it to `/`).

## 4. Turn on GitHub Pages

1. In the repository: **Settings**, then **Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. That is all. There is no branch to pick.

## 5. Run the Supabase workflow

1. In the repository click the **Actions** tab. If GitHub asks you to enable workflows, enable them.
2. In the left list click **Deploy Supabase (database and email functions)**, then **Run workflow**, then the green **Run workflow** button.
3. Wait for the run to finish (a few minutes). A green check means: the database tables and functions were created, the three email functions were deployed, and any email secrets were stored.
4. If it is red, open the run, click the failed step and read the last lines. See Troubleshooting.

The same workflow runs again by itself whenever you push changes under `supabase/` to the `main` branch. Database changes are applied in order and each is applied once.

The website workflow (**Deploy web app to GitHub Pages**) ran when you uploaded the code. If it ran before you added the variables in step 3, run it again: **Actions**, that workflow, **Run workflow**. When it finishes, the run page shows your site address.

## 6. Extensions (pg_cron and pg_net)

Email scheduling needs two Postgres extensions, `pg_cron` (the timer) and `pg_net` (lets the database call the email function). The database migrations try to enable them. To check: in Supabase open **Database**, then **Extensions** (check in the dashboard), search for `pg_cron` and `pg_net`, and make sure both are switched on. Switch them on by hand if not. If you do not want email at all you can skip this, but the schedule still runs harmlessly.

## 7. Add the two Vault secrets

The 15 minute timer needs to know your project URL and the service-role key. They are stored encrypted in Supabase Vault.

1. In Supabase open **SQL Editor**, then **New query**.
2. Paste this, replacing the two placeholders (keep the single quotes), and click **Run**:

```sql
select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co', 'project_url');
select vault.create_secret('PASTE-THE-SERVICE-ROLE-KEY-HERE', 'service_role_key');
```

3. Check that both exist (this shows names only, not values):

```sql
select name from vault.secrets where name in ('project_url', 'service_role_key');
```

You should see two rows. If you ever need to change a value, run `select vault.update_secret(id, 'new value') from vault.secrets where name = 'service_role_key';` (check the Vault documentation if this errors). Never paste the service_role key into GitHub, the website, or an email.

## 8. Sign-in settings (Auth)

In Supabase open **Authentication** (check in the dashboard for the exact page names below).

1. **Providers**: make sure **Email** is enabled. Leave the others off. Instructors sign in with email and password.
2. **URL Configuration**:
   - **Site URL**: your Pages address, for example `https://<your-user>.github.io/<repo-name>/`.
   - **Redirect URLs**: add the same address, and the same address followed by `**` (for example `https://<your-user>.github.io/<repo-name>/**`).
3. **Who can create an account.** The allowlist (step 9) and course invites work by email address. So the app must know that the person signing in really owns that address. Pick one of these two setups.
   - **Setup A, no email needed (recommended to start):** turn **Allow new users to sign up** off, and turn **Confirm email** off. Then create each instructor's account yourself: **Authentication**, **Users**, **Add user**, **Create new user**, enter their email and a temporary password, and tick **Auto confirm user** (check in the dashboard for these names). Send them the password yourself and ask them to change it with "Forgot password" once email works, or just tell them to keep it private. Nobody else can create an account.
   - **Setup B, self sign-up:** leave **Allow new users to sign up** on and turn **Confirm email** on. Each new instructor must click a link in an email before signing in, which proves they own the address. This needs working email: Supabase's built-in sender is limited to a few emails per hour and, on some plans, only to members of your Supabase organization. Set Resend (step 10) as the custom SMTP sender in Supabase (check in the dashboard) before relying on this.
   - Do not combine sign-up **on** with Confirm email **off**. In that combination anyone who knows an allowlisted or invited instructor's email address can create an account under that address and get that instructor's access.

## 9. Add the first instructor to the allowlist

Only emails in `instructor_allowlist` can create courses. Add yourself (use the email you will sign up with, in lowercase):

1. **SQL Editor**, **New query**:

```sql
insert into public.instructor_allowlist (email) values ('you@university.edu');
```

2. Run it. To add more people later, run the same statement with their address, or invite them to a course from inside the app (an invited person can sign in without being on the allowlist). Under Setup A in step 8, also create their account under **Authentication**, **Users**.
3. Under Setup A, create your own account under **Authentication**, **Users** with that email. Under Setup B, open your Pages address and sign up with that email. Then sign in.

## 10. Optional: email with Resend

Without email, everything works except automatic messages. The app still lets you download every student's personal link as a CSV (on the course's student list), and you can send those with your own mail program's mail merge. Every email the app tried to send is recorded in the table `email_log` with status `skipped`, so nothing breaks.

To send email from the app:

1. Create a free account at resend.com.
2. **Domains**, then **Add domain**. Enter a domain you control (for example `yourdomain.edu`, or a subdomain such as `mail.yourdomain.edu`). Resend shows DNS records; add them at whoever manages your domain's DNS (often university IT) and click verify. Check in the dashboard for the exact menu names.
   - Without a verified domain, Resend only lets you send to your own account email (useful for a test, useless for students).
3. **API Keys**, then **Create API Key**, permission "Sending access". Copy the key (starts with `re_`).
4. In GitHub add secrets: `RESEND_API_KEY` (the key) and `EMAIL_FROM`, for example `Peer Feedback <feedback@yourdomain.edu>`. The address must be on the verified domain.
5. Run the **Deploy Supabase** workflow again (step 5). It stores the values in Supabase.
6. Test: send yourself a reminder from the instructor page (smoke test below), then look at `email_log` (see Troubleshooting for the query).

What the emails are: session opened, closing soon (24 hours before the student's own deadline, only for students who have not answered everything), results published, manual reminders from the instructor, and "email me my links" from the student landing page. The timer runs every 15 minutes.

## 11. Smoke test

Do this with a throwaway course. The fake roster below has 6 students in 2 teams. Use addresses you control (for example `you+s1@gmail.com` style addresses all reach your own inbox) if you want to test email; otherwise any address works.

Roster (save as a CSV file, or paste as text with these columns):

```
Section,Team,Name,Email,Comments
Section A,Team 1,Ada Test,you+ada@example.com,
Section A,Team 1,Ben Test,you+ben@example.com,
Section A,Team 1,Cy Test,you+cy@example.com,
Section A,Team 2,Dee Test,you+dee@example.com,
Section A,Team 2,Eli Test,you+eli@example.com,
Section A,Team 2,Fay Test,you+fay@example.com,
```

Checklist (tick each):

- [ ] Open the Pages address. The landing page loads with no error.
- [ ] Sign in with your allowlisted email (account created per step 8 Setup A or B).
- [ ] Create a course (code `TEST101`, time zone of your choice). It appears in your list.
- [ ] Enroll the roster above. 6 students, 2 teams are shown.
- [ ] Download the student links CSV. It has 6 rows with distinct links.
- [ ] Create a session from the template "team peer feedback (point-based)". Open time: a few minutes ago. Close time: tomorrow or later.
- [ ] Open Ada's link in a private browser window (no sign-in needed). The session is listed.
- [ ] Answer the questions as Ada, save, reload the page. Answers are still there.
- [ ] Open Ben's link and submit too. Check the instructor submission status shows Ada and Ben as submitted and the other four as not.
- [ ] Try an invalid answer (for example point totals that do not add up). The app refuses it with a clear message.
- [ ] Change the close time to more than 30 minutes ago (past any grace period), reload Ada's link. Saving is refused.
- [ ] Publish the results. Ada's results page shows teammates' feedback with names hidden or shown as the question's visibility says; the instructor results page shows everything; the CSV download opens.
- [ ] Open Ada's link with one character changed in the token. You see an "invalid link" message and no data.
- [ ] Regenerate Ben's link. The old link stops working, the new one works.
- [ ] Without Resend: in the SQL editor run the query under Troubleshooting. After about 15 minutes you see `skipped` rows for the "opened" email. With Resend: the test inboxes receive the email, and the link opens the session.
- [ ] Send a reminder to two students from the instructor page; check `email_log`.
- [ ] "Email me my links" on the landing page with `you+ada@example.com`: the page always says it was sent; with Resend, one email arrives listing the session; asking a fourth time within an hour sends nothing.
- [ ] Delete the test course when done.

## 12. Troubleshooting

**See what the emails did.** SQL Editor:

```sql
select created_at, kind, to_email, status, error
from public.email_log order by created_at desc limit 30;
```

`skipped` with `RESEND_API_KEY not set` means no email key reached Supabase: add the GitHub secrets and rerun the Supabase workflow. `failed` shows the provider's message, most often "domain is not verified" (step 10) or a `from` address outside the verified domain.

**Check the timer ran.** SQL Editor:

```sql
select jobname, schedule, active from cron.job;
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
```

(The job's name depends on the migration; check in the dashboard under **Integrations**, then Cron, if the query shows nothing.) If there is no job, check step 6. If runs fail with an authorization or missing secret error, repeat step 7.

**Email function logs.** Supabase **Edge Functions**, click a function, **Logs** (check in the dashboard).

**Common problems**

| Symptom | Likely cause and fix |
|---|---|
| Supabase workflow fails at "Check required secrets" | One of the three secrets is missing or misspelled (step 3). |
| Fails at "Link project" or "Push database migrations" with an authentication or password error | Wrong `SUPABASE_DB_PASSWORD` or token. If you forgot the database password, reset it in Supabase project settings under **Database** (check in the dashboard), then update the GitHub secret. |
| Fails at migrations with "extension ... is not available" or permission error | Switch the extensions on by hand (step 6) and rerun. |
| Fails at "Deploy Edge Functions" | Open the log. A token error means `SUPABASE_ACCESS_TOKEN` is wrong or expired. |
| Pages workflow fails at `npm ci` | `web/package-lock.json` is missing from the upload. Upload it and rerun. |
| Pages workflow fails at "Get Pages site" (configure-pages) | Step 4 was skipped: set Source to GitHub Actions. |
| Site loads but is blank or says it cannot reach the server | The two `VITE_` variables are missing or wrong. Fix them in step 3 and rerun the Pages workflow. |
| Site shows 404 on the Pages address | Wait a minute after the first deploy; check Settings, Pages shows the site as published. |
| `.github` folder missing after browser upload | Create the files by hand: in the repository click **Add file**, **Create new file**, type `.github/workflows/deploy-pages.yml` as the name (typing the slashes makes folders), paste the contents, commit. Repeat for `deploy-supabase.yml`. |
| Sign-in says "Email not confirmed" | Setup B: click the link in the confirmation email. Setup A: the account was created without **Auto confirm user**; delete it and create it again with that box ticked. |
| Instructor cannot create a course | Their email is not in `instructor_allowlist`, or differs in case or spelling (step 9). |
| Sign-in link or email goes to the wrong address, or says redirect not allowed | Site URL and Redirect URLs (step 8) do not match your Pages address. |
| Students say a link does not work | The link was regenerated, or was cut in two by their mail program. Send a fresh link, or have them use "email me my links". |
| Emails are very late | The timer runs every 15 minutes. Anything longer: see "Check the timer ran". |
| Project paused | Restore it in the Supabase dashboard (step 2 note). |

To start over with an empty database, create a new Supabase project and repeat steps 2, 3, 5, 7, 8, 9 (the website variables and secrets change; nothing else does).
