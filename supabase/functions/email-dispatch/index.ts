// Cron target (pg_cron + pg_net every 15 minutes): opened, closing-soon and published emails.
// Auth: the x-cron-secret header must equal the function secret CRON_SECRET (constant-time compare). The timer
// reads the same value from the Vault secret cron_secret (migration 20261117000012). No Supabase API key is
// involved, so the retirement of the legacy service_role key does not affect the timer. verify_jwt is false in
// config.toml because this function checks the secret itself.

import { fetchAll, env, makeLogger, requireEnv, resendConfig, serviceClient, skipReason } from "../_shared/clients.ts";
import { planDueEmails, stampablePlans } from "../_shared/due.ts";
import { cronAuthorized, json } from "../_shared/http.ts";
import { sendAll } from "../_shared/send.ts";
import type {
  CourseRow, EmailLogRow, ExtensionRow, InstructorPresenceRow, PlannedEmail, QuestionRow, ResponseKeyRow, SessionRow, StudentRow,
} from "../_shared/types.ts";

/** Stop starting new emails after this long, so the function ends before the platform time limit. The next run continues. */
const BUDGET_MS = 110_000;

Deno.serve(async (req) => {
  const started = Date.now();
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "method_not_allowed" }, 405, {});
  const cronSecret = env("CRON_SECRET");
  if (!cronSecret) {
    console.error("email-dispatch: the function secret CRON_SECRET is not set (DEPLOY.md step 7)");
    return json({ error: "unauthorized" }, 401, {});
  }
  if (!cronAuthorized(req, cronSecret)) return json({ error: "unauthorized" }, 401, {});

  try {
    const db = serviceClient();
    const appUrl = requireEnv("APP_URL");
    const now = new Date();
    const nowIso = now.toISOString();
    const cols = "id, course_id, name, instructions, opens_at, closes_at, grace_minutes, results_visibility, results_visible_at, published_at, closing_email_enabled, published_email_enabled, opened_email_sent_at, closing_email_sent_at, published_email_sent_at";

    // Candidate sessions (the pure planner re-checks every condition).
    const byId = new Map<string, SessionRow>();
    const add = (rows: SessionRow[] | null) => (rows ?? []).forEach((s) => byId.set(s.id, s));
    const q1 = await db.from("sessions").select(cols).lte("opens_at", nowIso).gt("closes_at", nowIso);
    if (q1.error) throw new Error(q1.error.message);
    add(q1.data as SessionRow[]);
    // Only sessions that can be published: published by hand, or visible at open or at a set time.
    const q2 = await db.from("sessions").select(cols).eq("published_email_enabled", true).is("published_email_sent_at", null)
      .or("published_at.not.is.null,results_visibility.in.(at_open,custom)");
    if (q2.error) throw new Error(q2.error.message);
    add(q2.data as SessionRow[]);
    // Sessions whose normal close passed but some student has a later extension.
    const q3 = await db.from("deadline_extensions").select("session_id").gt("closes_at", nowIso);
    if (q3.error) throw new Error(q3.error.message);
    const extSessionIds = [...new Set((q3.data ?? []).map((r: { session_id: string }) => r.session_id))].filter((id) => !byId.has(id));
    if (extSessionIds.length > 0) {
      const q4 = await db.from("sessions").select(cols).in("id", extSessionIds).lte("opens_at", nowIso);
      if (q4.error) throw new Error(q4.error.message);
      add(q4.data as SessionRow[]);
    }
    const sessions = [...byId.values()];
    if (sessions.length === 0) return json({ ok: true, sent: 0, failed: 0, skipped: 0, plans: 0 }, 200, {});

    const sessionIds = sessions.map((s) => s.id);
    const courseIds = [...new Set(sessions.map((s) => s.course_id))];
    const [courses, students, extensions, questions, responses, emailLog, instructors] = await Promise.all([
      fetchAll<CourseRow>((a, b) => db.from("courses").select("id, code, name, time_zone, archived_at").in("id", courseIds).order("id").range(a, b)),
      fetchAll<StudentRow>((a, b) => db.from("students").select("id, course_id, name, email, access_token, section, team").in("course_id", courseIds).order("id").range(a, b)),
      fetchAll<ExtensionRow>((a, b) => db.from("deadline_extensions").select("session_id, student_id, closes_at").in("session_id", sessionIds).order("session_id").order("student_id").range(a, b)),
      fetchAll<QuestionRow>((a, b) => db.from("questions").select("id, session_id, giver_type, recipient_type").in("session_id", sessionIds).order("id").range(a, b)),
      fetchAll<ResponseKeyRow>((a, b) => db.from("responses").select("session_id, question_id, giver_key").in("session_id", sessionIds).order("id").range(a, b)),
      fetchAll<EmailLogRow>((a, b) => db.from("email_log").select("session_id, kind, to_email, student_id, status, created_at").in("session_id", sessionIds).in("kind", ["opened", "closing", "published"]).order("id").range(a, b)),
      fetchAll<InstructorPresenceRow>((a, b) => db.from("course_instructors").select("course_id, is_displayed_to_students").in("course_id", courseIds).order("id").range(a, b)),
    ]);

    const plans = planDueEmails({ now, appUrl, courses, sessions, students, extensions, questions, responses, emailLog, instructors });
    const all: PlannedEmail[] = plans.flatMap((p) => p.emails);

    const summary = await sendAll(all, {
      resend: resendConfig(),
      skipReason: skipReason(),
      log: makeLogger(db),
      deadlineMs: started + BUDGET_MS,
    });

    // Set the stamp for each plan whose emails were all attempted and left nothing to retry (stampablePlans).
    let stamped = 0;
    for (const p of stampablePlans(plans, summary.outcomes)) {
      const { error } = await db.from("sessions").update({ [p.stampField]: new Date().toISOString() }).eq("id", p.sessionId);
      if (error) console.error("stamp failed", p.sessionId, p.stampField, error.message);
      else stamped++;
    }
    const incomplete = summary.processed < all.length;
    const { outcomes: _outcomes, ...counts } = summary;
    console.log(JSON.stringify({ fn: "email-dispatch", ...counts, planned: all.length, plans: plans.length, stamped, incomplete }));
    return json({ ok: true, ...counts, planned: all.length, plans: plans.length, stamped, incomplete }, 200, {});
  } catch (e) {
    console.error("email-dispatch error", (e as Error).message);
    return json({ ok: false, error: (e as Error).message }, 500, {});
  }
});
