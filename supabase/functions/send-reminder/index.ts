// Instructor-triggered reminders. Body: {session_id, student_ids[], kind: 'submit'|'results', copy_to_me: bool}.
// Auth: the caller's JWT is verified with Supabase Auth, then has_perm(course, 'modify_sessions') is
// called as the caller (RPC), so the database decides. verify_jwt is false in config.toml because the
// function verifies the token itself.

import { callerClient, fetchAll, makeLogger, requireEnv, resendConfig, serviceClient, skipReason, env } from "../_shared/clients.ts";
import { copyForInstructor, planReminders } from "../_shared/due.ts";
import { bearer, corsHeaders, json } from "../_shared/http.ts";
import { sendAll } from "../_shared/send.ts";
import type { CourseRow, ExtensionRow, SessionRow, StudentRow } from "../_shared/types.ts";

const MAX_STUDENTS = 200;
const BUDGET_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const started = Date.now();
  const cors = corsHeaders(req.headers.get("Origin"), env("APP_URL"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);

  try {
    // 1. Who is calling?
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = bearer(req);
    if (!jwt) return json({ error: "unauthorized" }, 401, cors);
    const caller = callerClient(authHeader);
    const { data: userData, error: userErr } = await caller.auth.getUser(jwt);
    if (userErr || !userData?.user?.email) return json({ error: "unauthorized" }, 401, cors);
    const instructorEmail = userData.user.email.toLowerCase();

    // 2. Validate the body.
    const body = await req.json().catch(() => null) as
      | { session_id?: unknown; student_ids?: unknown; kind?: unknown; copy_to_me?: unknown }
      | null;
    const sessionId = body?.session_id;
    const studentIds = body?.student_ids;
    const kind = body?.kind;
    if (typeof sessionId !== "string" || !UUID.test(sessionId)) return json({ error: "bad_session_id" }, 400, cors);
    if (kind !== "submit" && kind !== "results") return json({ error: "bad_kind" }, 400, cors);
    if (!Array.isArray(studentIds) || studentIds.length === 0 || !studentIds.every((x) => typeof x === "string" && UUID.test(x))) {
      return json({ error: "bad_student_ids" }, 400, cors);
    }
    if (studentIds.length > MAX_STUDENTS) return json({ error: "too_many_students", max: MAX_STUDENTS }, 400, cors);
    const copyToMe = body?.copy_to_me === true;

    // 3. Look up the session, then ask the database whether the caller may modify sessions of its course.
    const db = serviceClient();
    const sRes = await db.from("sessions")
      .select("id, course_id, name, instructions, opens_at, closes_at, grace_minutes, results_visibility, results_visible_at, published_at, closing_email_enabled, published_email_enabled, opened_email_sent_at, closing_email_sent_at, published_email_sent_at")
      .eq("id", sessionId).maybeSingle();
    if (sRes.error) throw new Error(sRes.error.message);
    if (!sRes.data) return json({ error: "forbidden" }, 403, cors); // same answer as "no permission": do not reveal which ids exist
    const session = sRes.data as SessionRow;
    const perm = await caller.rpc("has_perm", { p_course: session.course_id, p_perm: "modify_sessions" });
    if (perm.error || perm.data !== true) return json({ error: "forbidden" }, 403, cors);

    // 4. Plan.
    const cRes = await db.from("courses").select("id, code, name, time_zone, archived_at").eq("id", session.course_id).single();
    if (cRes.error) throw new Error(cRes.error.message);
    const students = await fetchAll<StudentRow>((a, b) =>
      db.from("students").select("id, course_id, name, email, access_token").eq("course_id", session.course_id).in("id", studentIds as string[]).order("id").range(a, b));
    const extensions = await fetchAll<ExtensionRow>((a, b) =>
      db.from("deadline_extensions").select("session_id, student_id, closes_at").eq("session_id", sessionId).order("student_id").range(a, b));
    const plan = planReminders({
      now: new Date(), appUrl: requireEnv("APP_URL"), kind, course: cRes.data as CourseRow, session, students, extensions,
    });
    if (!plan.ok) return json({ error: plan.error }, 400, cors);

    const emails = [...plan.emails];
    if (copyToMe && emails.length > 0) emails.push(copyForInstructor(emails[0], instructorEmail, emails.length));

    // 5. Send politely and log.
    const summary = await sendAll(emails, {
      resend: resendConfig(), skipReason: skipReason(), log: makeLogger(db), deadlineMs: started + BUDGET_MS,
    });
    return json({
      ok: true,
      sent: summary.sent, failed: summary.failed, skipped: summary.skipped,
      ignored: plan.ignored + (studentIds.length - students.length),
      remaining: emails.length - summary.processed,
    }, 200, cors);
  } catch (e) {
    console.error("send-reminder error", (e as Error).message);
    return json({ ok: false, error: "internal_error" }, 500, cors);
  }
});
