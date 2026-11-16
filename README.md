# Peer feedback

A web app for student team peer evaluations, built to replace the TEAMMATES service, which shuts down on December 31, 2026. It runs on GitHub Pages (the web app) and a free Supabase project (database, sign-in, email functions).

Students need no account: each gets a personal link. Instructors sign in with email and password.

## What it does

- Courses, rosters from CSV (`Section, Team, Name, Email, Comments`), co-instructors with roles.
- Sessions from the TEAMMATES point-based and percentage-based peer feedback templates, or your own questions.
- All 10 TEAMMATES question types, feedback paths for student and instructor givers, per-question visibility settings.
- Open and close times, grace period, deadline extensions, reminders, moderation, preview as a student.
- Results by question (with statistics, including the TEAMMATES contribution calculation), by giver and by recipient; CSV download; publish to students.
- Automatic emails through Resend if configured; otherwise a CSV of every student's link for mail merge.

See `docs/ARCHITECTURE.md` section 3 for what is not built.

## Documents

- `docs/DEPLOY.md`: how to set it up, step by step, with a smoke test.
- `docs/INSTRUCTOR_GUIDE.md`: how to use it.
- `docs/ARCHITECTURE.md`: design and data model.
- `BUILD_NOTES/`: what was built in each step, the independent review, and the fixes.

## Tests

- Database: `bash supabase/tests/run.sh` (needs PostgreSQL 16 binaries).
- Web: `cd web && npm ci && npm test && npm run typecheck && npm run build`.
- Email functions: `deno test supabase/functions/_shared/`.

## Credit and license

This project ports parts of [TEAMMATES](https://github.com/TEAMMATES/teammates) by the National University of Singapore: the contribution calculation, its test cases, and the peer feedback template questions. TEAMMATES is licensed under GPL-2.0, and so is this project (see `LICENSE`).
