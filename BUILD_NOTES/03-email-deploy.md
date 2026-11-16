# 03 Email functions, deploy workflows, deploy guide

## State found
The previous agent had written `supabase/functions/_shared/*`, the three functions, `supabase/config.toml` and both workflows. I read all of it against ARCHITECTURE.md sections 1, 2, 4, 5, 10, 11 and teammates-spec section g. No logic bugs found; the pure logic matches section 10.

## Changes made in this step
- Installed Deno 2.9.6 with `npm i -g deno`. It worked, so no Node fallback was needed.
- `deno test supabase/functions/_shared/`: 28 passed, 0 failed. `deno check` passes for `email-dispatch`, `send-reminder`, `recover-links`.
- `deploy-supabase.yml`: added `--use-api` to `supabase functions deploy` so the CI runner needs no Docker.
- Both workflow files parse as YAML (checked with PyYAML).
- Wrote `docs/DEPLOY.md`.

## Behavior (as implemented)
- `_shared`: `clients.ts` (service-role client, caller-JWT client, Resend config), `resend.ts` (fetch, one retry on 429, never throws), `send.ts` (sequential, 600 ms pause, one `email_log` row per attempt, `skipped` rows when `RESEND_API_KEY` or `EMAIL_FROM` is missing), `templates.ts`, `due.ts` (pure: `planDueEmails`, `planRecovery`, `planReminders`, `recoveryRateLimited`), `http.ts` (CORS for the `APP_URL` origin plus localhost).
- `email-dispatch`: Authorization must equal the service-role key (constant-time compare). Stops starting emails after 110 s; remaining students are picked up by the next run because per-student `email_log` rows are checked before sending and the session stamp is set only when every email of a plan was attempted.
- `send-reminder`: verifies the JWT with Auth, then calls `has_perm(p_course, 'modify_sessions')` as the caller. Unknown session and no permission both return 403. Max 200 students per call.
- `recover-links`: always `{ok: true}`, including on errors. Rate limit 3 per email per hour from `email_log` rows of kind `recovery` (counts `sent`, `failed` and `skipped`).

## Decisions and deviations from ARCHITECTURE.md
- Section 10 says nothing about a stale published email. Decision: if results were published more than 7 days ago and the stamp is null, stamp without sending (avoids mass email after a long outage or a late migration).
- The closing-soon email shows the student's own deadline (extension, else `closes_at` without grace). The grace period is not advertised.
- `send-reminder` and `recover-links` use `verify_jwt = false` in config.toml (the former because it verifies the token itself and must return CORS headers on preflight). Requirement 3 named only two functions; this is the one addition.
- `send-reminder` reads data with the service role after the permission check (the RPC is the gate). It does not rely on RLS for the student list.
- The recovery email does not send when the address has no student rows or no sessions opened in the last 180 days (TEAMMATES sends a separate "not found" email; skipped to avoid becoming an open mail relay).
- Candidate session selection in `email-dispatch` is wider than the planner needs; the planner re-checks every condition.
- Not built (section 3 already excludes): opening-soon and closed emails to instructors, extension emails, unpublished email.
- The default `APP_URL` in `deploy-supabase.yml` is `https://<owner>.github.io/<repo>`; the `APP_URL` secret overrides it.
- `DEPLOY.md` recommends "Confirm email: off" for a first run, relying on the allowlist.

## What the database must provide
Tables and columns, as in section 5 (the existing schema migration matches):
- `courses(id, code, name, time_zone, archived_at)`
- `students(id, course_id, name, email, access_token)`
- `sessions(id, course_id, name, instructions, opens_at, closes_at, grace_minutes, results_visibility, results_visible_at, published_at, closing_email_enabled, published_email_enabled, opened_email_sent_at, closing_email_sent_at, published_email_sent_at)`
- `questions(id, session_id, giver_type)`, `responses(id, session_id, question_id, giver_key)` (ordered by `id` when paging)
- `deadline_extensions(session_id, student_id, closes_at)`
- `email_log(id, session_id, kind, to_email, student_id, status, error, created_at)`; the service role must be able to insert and select. Kinds written: `opened, closing, published, reminder, results_reminder, reminder_copy, recovery`.
RPC: `has_perm(p_course uuid, p_perm text) returns boolean`, executable by `authenticated`.
Cron migration (owned by the database step): every 15 minutes, `net.http_post` to `<project_url>/functions/v1/email-dispatch` with header `Authorization: Bearer <service_role_key>`, reading `project_url` and `service_role_key` from `vault.decrypted_secrets`. DEPLOY.md step 7 creates those two Vault secrets with those exact names; the migration must use the same names.
Service-role access to tables needs no RLS policy (service role bypasses RLS).

## Issues and open items
- `BUILD_NOTES/01-database.md` did not exist when I finished; the cron migration was not present in `supabase/migrations`, so I could not check the Vault secret names or cron job name. DEPLOY.md troubleshooting queries `cron.job` generically.
- Not verified (no network access to the vendors): Supabase and GitHub dashboard menu names, `supabase functions deploy --use-api` on the latest CLI, a live Resend send. DEPLOY.md marks these "check in the dashboard".
- `web` must have `web/package-lock.json` committed (the Pages workflow runs `npm ci`; it exists now).
- The frontend must call the functions at `<VITE_SUPABASE_URL>/functions/v1/recover-links` and `/send-reminder` with POST and JSON bodies as in section 10; `send-reminder` returns `{ok, sent, failed, skipped, ignored, remaining}` or `{error}` with 400, 401 or 403.
