// Public: "email me my links". Body {email}. Always answers {ok: true} at once; the lookup and the send run
// in the background (EdgeRuntime.waitUntil), so the response time does not reveal whether an address is
// enrolled. Limits: 3 per address per hour and 200 per hour in total, enforced by claim_recovery_slot() in SQL,
// which writes a pending email_log row before anything is sent.
// verify_jwt is false in config.toml (anonymous callers).

import { env, fetchAll, requireEnv, resendConfig, serviceClient, skipReason } from "../_shared/clients.ts";
import {
  normalizeEmail, planRecovery, RECOVERY_GLOBAL_LIMIT, RECOVERY_LIMIT, RECOVERY_LOOKBACK_MS, RECOVERY_WINDOW_MS,
} from "../_shared/due.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { deliverRecovery } from "../_shared/recovery.ts";
import type { CourseRow, EmailLogRow, ExtensionRow, SessionRow, StudentRow } from "../_shared/types.ts";

// Edge runtime global: keeps the work running after the response is sent. Absent in local tests.
declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

async function recover(email: string): Promise<void> {
  const db = serviceClient();
  const now = new Date();
  const students = await fetchAll<StudentRow>((a, b) =>
    db.from("students").select("id, course_id, name, email, access_token").eq("email", email).order("id").range(a, b));
  if (students.length === 0) return;

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
  if (!planned) return;
  await deliverRecovery(planned, {
    resend: resendConfig(),
    skipReason: skipReason(),
    claim: async () => {
      const { data, error } = await db.rpc("claim_recovery_slot", {
        p_email: email, p_limit: RECOVERY_LIMIT, p_global: RECOVERY_GLOBAL_LIMIT,
      });
      if (error) throw new Error(error.message);
      return (data as string | null) ?? null;
    },
    finish: async (id, status, error) => {
      const { error: e } = await db.from("email_log").update({ status, error }).eq("id", id);
      if (e) console.error("email_log update failed", e.message);
    },
  });
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"), env("APP_URL"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
  const ok = () => json({ ok: true }, 200, cors);

  const body = await req.json().catch(() => null) as { email?: unknown } | null;
  const email = normalizeEmail(body?.email);
  if (!email) return ok();

  // Never reveal anything, including failures.
  const work = recover(email).catch((e) => console.error("recover-links error", (e as Error).message));
  const rt = typeof EdgeRuntime === "undefined" ? undefined : EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work);
  else await work; // no background runtime: answer after the work (response time can then differ)
  return ok();
});
