// Public: "email me my links". Body {email}. Always answers {ok: true} so the response never
// reveals whether an address is enrolled. Rate limit: 3 per email per hour, counted in email_log.
// verify_jwt is false in config.toml (anonymous callers).

import { env, fetchAll, makeLogger, requireEnv, resendConfig, serviceClient, skipReason } from "../_shared/clients.ts";
import { normalizeEmail, planRecovery, RECOVERY_LOOKBACK_MS, RECOVERY_WINDOW_MS } from "../_shared/due.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { sendAll } from "../_shared/send.ts";
import type { CourseRow, EmailLogRow, ExtensionRow, SessionRow, StudentRow } from "../_shared/types.ts";

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"), env("APP_URL"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
  const ok = () => json({ ok: true }, 200, cors);

  try {
    const body = await req.json().catch(() => null) as { email?: unknown } | null;
    const email = normalizeEmail(body?.email);
    if (!email) return ok();

    const db = serviceClient();
    const now = new Date();
    const students = await fetchAll<StudentRow>((a, b) =>
      db.from("students").select("id, course_id, name, email, access_token").eq("email", email).order("id").range(a, b));
    if (students.length === 0) return ok();

    const since = new Date(now.getTime() - RECOVERY_WINDOW_MS).toISOString();
    const log = await fetchAll<EmailLogRow>((a, b) =>
      db.from("email_log").select("session_id, kind, to_email, student_id, status, created_at")
        .eq("kind", "recovery").eq("to_email", email).gt("created_at", since).order("id").range(a, b));

    const courseIds = [...new Set(students.map((s) => s.course_id))];
    const opensSince = new Date(now.getTime() - RECOVERY_LOOKBACK_MS).toISOString();
    const [courses, sessions] = await Promise.all([
      fetchAll<CourseRow>((a, b) => db.from("courses").select("id, code, name, time_zone, archived_at").in("id", courseIds).order("id").range(a, b)),
      fetchAll<SessionRow>((a, b) =>
        db.from("sessions")
          .select("id, course_id, name, instructions, opens_at, closes_at, grace_minutes, results_visibility, results_visible_at, published_at, closing_email_enabled, published_email_enabled, opened_email_sent_at, closing_email_sent_at, published_email_sent_at")
          .in("course_id", courseIds).lte("opens_at", now.toISOString()).gte("opens_at", opensSince).order("id").range(a, b)),
    ]);
    const sessionIds = sessions.map((s) => s.id);
    const extensions = sessionIds.length === 0 ? [] : await fetchAll<ExtensionRow>((a, b) =>
      db.from("deadline_extensions").select("session_id, student_id, closes_at")
        .in("session_id", sessionIds).in("student_id", students.map((s) => s.id)).order("session_id").order("student_id").range(a, b));

    const planned = planRecovery({ now, appUrl: requireEnv("APP_URL"), email, students, courses, sessions, extensions, emailLog: log });
    if (planned) {
      await sendAll([planned], { resend: resendConfig(), skipReason: skipReason(), log: makeLogger(db) });
    }
    return ok();
  } catch (e) {
    console.error("recover-links error", (e as Error).message);
    return ok(); // never reveal anything, including failures
  }
});
