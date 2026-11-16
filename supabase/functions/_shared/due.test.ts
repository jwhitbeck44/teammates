// Unit tests for the pure due-email logic. Run: deno test supabase/functions/_shared/
import assert from "node:assert/strict";
import {
  copyForInstructor, normalizeEmail, planDueEmails, planRecovery, planReminders, recoveryRateLimited,
  isPublished, type DueInput,
} from "./due.ts";
import { sendAll } from "./send.ts";
import { sendViaResend } from "./resend.ts";
import { allowedOrigin } from "./http.ts";
import { formatDeadline, renderSessionEmail, submitLink, resultsLink } from "./templates.ts";
import type { CourseRow, EmailLogRow, SessionRow, StudentRow, PlannedEmail } from "./types.ts";

const APP = "https://prof.github.io/peer-feedback/";
const NOW = new Date("2026-03-10T15:00:00Z");
const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (hours: number) => iso(NOW.getTime() + hours * H);

const course: CourseRow = { id: "c1", code: "MGMT3300", name: "Teams & <Leadership>", time_zone: "America/Denver", archived_at: null };
const student = (n: number, courseId = "c1"): StudentRow => ({
  id: `st${n}`, course_id: courseId, name: `Student ${n}`, email: `s${n}@example.edu`, access_token: `tok${n}`,
});
const students = [1, 2, 3].map((n) => student(n));

function session(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "se1", course_id: "c1", name: "Peer eval 1", instructions: "Be kind.\nBe honest.",
    opens_at: at(-1), closes_at: at(24 * 7), grace_minutes: 15,
    results_visibility: "later", results_visible_at: null, published_at: null,
    closing_email_enabled: true, published_email_enabled: true,
    opened_email_sent_at: null, closing_email_sent_at: null, published_email_sent_at: null, ...over,
  };
}

function input(over: Partial<DueInput> = {}): DueInput {
  return {
    now: NOW, appUrl: APP, courses: [course], sessions: [session()], students, extensions: [],
    questions: [{ id: "q1", session_id: "se1", giver_type: "students" }, { id: "q2", session_id: "se1", giver_type: "students" }],
    responses: [], emailLog: [], ...over,
  };
}
const log = (kind: string, studentId: string | null, status: EmailLogRow["status"] = "sent", sessionId = "se1"): EmailLogRow =>
  ({ session_id: sessionId, kind, to_email: "x@y.z", student_id: studentId, status, created_at: iso(NOW.getTime() - H) });
const byKind = (plans: ReturnType<typeof planDueEmails>, kind: string) => plans.filter((p) => p.kind === kind);

Deno.test("opened: every student gets a personal link, stamp needed", () => {
  const plans = byKind(planDueEmails(input()), "opened");
  assert.equal(plans.length, 1);
  const p = plans[0];
  assert.equal(p.stampField, "opened_email_sent_at");
  assert.equal(p.stampNeeded, true);
  assert.deepEqual(p.emails.map((e) => e.to), students.map((s) => s.email));
  assert.ok(p.emails[0].text.includes("https://prof.github.io/peer-feedback/#/s/tok1/sessions/se1"));
  assert.ok(p.emails[0].html.includes('href="https://prof.github.io/peer-feedback/#/s/tok1/sessions/se1"'));
  assert.ok(p.emails[0].text.includes("[MGMT3300] Teams & <Leadership>"));
  assert.ok(p.emails[0].html.includes("Teams &amp; &lt;Leadership&gt;"));
  assert.ok(p.emails[0].subject.includes("Peer eval 1"));
});

{
  Deno.test("opened: not when already stamped, not yet open, closed, or opened over 2 days ago", () => {
    assert.equal(byKind(planDueEmails(input({ sessions: [session({ opened_email_sent_at: at(-0.5) })] })), "opened").length, 0);
    assert.equal(byKind(planDueEmails(input({ sessions: [session({ opens_at: at(1) })] })), "opened").length, 0);
    assert.equal(byKind(planDueEmails(input({ sessions: [session({ opens_at: at(-72), closes_at: at(-1) })] })), "opened").length, 0);
    assert.equal(byKind(planDueEmails(input({ sessions: [session({ opens_at: at(-49) })] })), "opened").length, 0);
    assert.equal(byKind(planDueEmails(input({ sessions: [session({ opens_at: at(-47) })] })), "opened").length, 1);
  });
  Deno.test("opened: students already logged are skipped (resume after a partial run); archived courses get nothing", () => {
    const plans = byKind(planDueEmails(input({ emailLog: [log("opened", "st1")] })), "opened");
    assert.deepEqual(plans[0].emails.map((e) => e.studentId), ["st2", "st3"]);
    const archived = planDueEmails(input({ courses: [{ ...course, archived_at: at(-100) }] }));
    assert.equal(archived.length, 0);
  });
}

Deno.test("closing soon: students within 24h of the deadline get one, deadline in course time zone", () => {
  // closes in 10 hours: 2026-03-11 01:00 UTC. DST started Mar 8 2026, so Denver is on MDT (UTC-6): 7:00 PM.
  const s = session({ opens_at: at(-100), closes_at: at(10) });
  const plans = byKind(planDueEmails(input({ sessions: [s] })), "closing");
  assert.equal(plans.length, 1);
  assert.equal(plans[0].emails.length, 3);
  assert.equal(plans[0].stampNeeded, true);
  assert.ok(plans[0].emails[0].text.includes("Deadline: Tue, Mar 10, 2026, 7:00 PM MDT"), plans[0].emails[0].text);
  assert.ok(plans[0].emails[0].text.includes("/#/s/tok1/sessions/se1"));
});

Deno.test("closing soon: nothing more than 24h before the deadline, nothing after it, nothing when disabled or session is 24h or shorter", () => {
  const far = session({ opens_at: at(-100), closes_at: at(30) });
  assert.equal(byKind(planDueEmails(input({ sessions: [far] })), "closing").length, 0);
  const past = session({ opens_at: at(-100), closes_at: at(-1), grace_minutes: 30 });
  assert.equal(byKind(planDueEmails(input({ sessions: [past] })), "closing").flatMap((p) => p.emails).length, 0);
  const off = session({ opens_at: at(-100), closes_at: at(10), closing_email_enabled: false });
  assert.equal(byKind(planDueEmails(input({ sessions: [off] })), "closing").length, 0);
  const short = session({ opens_at: at(-10), closes_at: at(10) }); // 20h long
  assert.equal(byKind(planDueEmails(input({ sessions: [short] })), "closing").length, 0);
  const exactly24 = session({ opens_at: at(-14), closes_at: at(10) });
  assert.equal(byKind(planDueEmails(input({ sessions: [exactly24] })), "closing").length, 0);
});

Deno.test("closing soon: students who answered every question, or have a log row, are skipped", () => {
  const s = session({ opens_at: at(-100), closes_at: at(10) });
  const done = [
    { session_id: "se1", question_id: "q1", giver_key: "s:st1" },
    { session_id: "se1", question_id: "q2", giver_key: "s:st1" },
  ];
  const partial = [{ session_id: "se1", question_id: "q1", giver_key: "s:st2" }];
  const plans = byKind(planDueEmails(input({ sessions: [s], responses: [...done, ...partial], emailLog: [log("closing", "st3")] })), "closing");
  assert.deepEqual(plans[0].emails.map((e) => e.studentId), ["st2"]);
});

Deno.test("closing soon: instructor-giver questions do not count; no student questions means nobody is nagged", () => {
  const s = session({ opens_at: at(-100), closes_at: at(10) });
  const onlyInstructor = input({ sessions: [s], questions: [{ id: "q9", session_id: "se1", giver_type: "instructors" }] });
  const plans = byKind(planDueEmails(onlyInstructor), "closing");
  assert.equal(plans[0].emails.length, 0);
  assert.equal(plans[0].stampNeeded, true);
});

Deno.test("closing soon: extensions move the email to 24h before the student's own deadline", () => {
  const s = session({ opens_at: at(-100), closes_at: at(10) });
  // st1 has an extension of 3 more days: not yet within 24h. st2 has one ending in 20h: due now.
  const extensions = [
    { session_id: "se1", student_id: "st1", closes_at: at(10 + 72) },
    { session_id: "se1", student_id: "st2", closes_at: at(20) },
  ];
  const plans = byKind(planDueEmails(input({ sessions: [s], extensions })), "closing");
  assert.deepEqual(plans[0].emails.map((e) => e.studentId), ["st2", "st3"]);
  const st2 = plans[0].emails.find((e) => e.studentId === "st2")!;
  assert.ok(st2.text.includes("Deadline: Wed, Mar 11, 2026, 5:00 AM MDT"), st2.text);
});

Deno.test("closing soon: after the session closes, an extension holder still gets their email 24h before their deadline", () => {
  const s = session({ opens_at: at(-200), closes_at: at(-5), closing_email_sent_at: at(-29) });
  const extensions = [{ session_id: "se1", student_id: "st1", closes_at: at(12) }];
  const plans = byKind(planDueEmails(input({ sessions: [s], extensions })), "closing");
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].emails.map((e) => e.studentId), ["st1"]);
  assert.equal(plans[0].stampNeeded, false);
});

Deno.test("closing soon: stamp already set and nobody due gives no plan", () => {
  const s = session({ opens_at: at(-100), closes_at: at(10), closing_email_sent_at: at(-1) });
  const logs = students.map((st) => log("closing", st.id));
  assert.equal(byKind(planDueEmails(input({ sessions: [s], emailLog: logs })), "closing").length, 0);
});

Deno.test("published: manual publish, at_open and custom time all count; links go to results", () => {
  const manual = session({ published_at: at(-0.2) });
  let plans = byKind(planDueEmails(input({ sessions: [manual] })), "published");
  assert.equal(plans[0].emails.length, 3);
  assert.ok(plans[0].emails[0].text.includes("/#/s/tok1/results/se1"));
  assert.equal(plans[0].stampField, "published_email_sent_at");
  plans = byKind(planDueEmails(input({ sessions: [session({ results_visibility: "at_open" })] })), "published");
  assert.equal(plans[0].emails.length, 3);
  const custom = session({ results_visibility: "custom", results_visible_at: at(-2) });
  assert.equal(byKind(planDueEmails(input({ sessions: [custom] })), "published")[0].emails.length, 3);
  const customFuture = session({ results_visibility: "custom", results_visible_at: at(2) });
  assert.equal(byKind(planDueEmails(input({ sessions: [customFuture] })), "published").length, 0);
});

Deno.test("published: not when unpublished, disabled, already stamped; stale publications are stamped without sending", () => {
  assert.equal(byKind(planDueEmails(input()), "published").length, 0);
  assert.equal(byKind(planDueEmails(input({ sessions: [session({ published_at: at(-1), published_email_enabled: false })] })), "published").length, 0);
  assert.equal(byKind(planDueEmails(input({ sessions: [session({ published_at: at(-1), published_email_sent_at: at(-0.5) })] })), "published").length, 0);
  const stale = byKind(planDueEmails(input({ sessions: [session({ published_at: at(-24 * 30) })] })), "published");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].emails.length, 0);
  assert.equal(stale[0].stampNeeded, true);
});

Deno.test("isPublished mirrors the SQL rule", () => {
  assert.equal(isPublished(session(), NOW), false);
  assert.equal(isPublished(session({ published_at: at(-1) }), NOW), true);
  assert.equal(isPublished(session({ results_visibility: "at_open", opens_at: at(1), closes_at: at(48) }), NOW), false);
  assert.equal(isPublished(session({ results_visibility: "custom", results_visible_at: null }), NOW), false);
});

Deno.test("recovery rate limit: 3 per email per hour, other emails and older rows do not count", () => {
  const row = (to: string, minsAgo: number, status: EmailLogRow["status"] = "sent", kind = "recovery"): EmailLogRow =>
    ({ session_id: null, kind, to_email: to, student_id: null, status, created_at: iso(NOW.getTime() - minsAgo * 60_000) });
  assert.equal(recoveryRateLimited(NOW, "a@x.edu", [row("a@x.edu", 5), row("a@x.edu", 10)]), false);
  assert.equal(recoveryRateLimited(NOW, "a@x.edu", [row("a@x.edu", 5), row("a@x.edu", 10), row("a@x.edu", 20)]), true);
  // skipped and failed rows count too, so the limit works without an email provider
  assert.equal(recoveryRateLimited(NOW, "a@x.edu", [row("a@x.edu", 5, "skipped"), row("a@x.edu", 6, "failed"), row("a@x.edu", 7, "skipped")]), true);
  assert.equal(recoveryRateLimited(NOW, "a@x.edu", [row("a@x.edu", 5), row("a@x.edu", 10), row("b@x.edu", 20)]), false);
  assert.equal(recoveryRateLimited(NOW, "a@x.edu", [row("a@x.edu", 5), row("a@x.edu", 10), row("a@x.edu", 61)]), false);
  assert.equal(recoveryRateLimited(NOW, "a@x.edu", [row("a@x.edu", 1, "sent", "closing"), row("a@x.edu", 2, "sent", "closing"), row("a@x.edu", 3, "sent", "closing")]), false);
});

Deno.test("recovery: lists sessions opened in the last 180 days across courses, results link only when published", () => {
  const course2: CourseRow = { id: "c2", code: "ENTP3000", name: "Entrepreneurship", time_zone: "UTC", archived_at: null };
  const stA = student(1, "c1");
  const stB = { ...student(1, "c2"), id: "stB", access_token: "tokB" };
  const sessions = [
    session({ id: "sOld", opens_at: at(-24 * 200), closes_at: at(-24 * 199) }),
    session({ id: "sRecent", name: "Recent", opens_at: at(-24 * 30), closes_at: at(-24 * 20), published_at: at(-24 * 19) }),
    session({ id: "sFuture", name: "Future", opens_at: at(24), closes_at: at(48) }),
    session({ id: "sOther", course_id: "c2", name: "Other course", opens_at: at(-5), closes_at: at(50) }),
  ];
  const plan = planRecovery({ now: NOW, appUrl: APP, email: "s1@example.edu", students: [stA, stB], courses: [course, course2], sessions, extensions: [], emailLog: [] });
  assert.ok(plan);
  assert.equal(plan!.to, "s1@example.edu");
  assert.equal(plan!.kind, "recovery");
  assert.ok(plan!.text.includes("/#/s/tok1/sessions/sRecent"));
  assert.ok(plan!.text.includes("/#/s/tok1/results/sRecent"));
  assert.ok(plan!.text.includes("/#/s/tokB/sessions/sOther"));
  assert.ok(!plan!.text.includes("/results/sOther"));
  assert.ok(!plan!.text.includes("sOld"));
  assert.ok(!plan!.text.includes("sFuture"));
});

Deno.test("recovery: null when rate limited, unknown email, or nothing opened in 180 days", () => {
  const sessions = [session({ id: "sRecent", opens_at: at(-24) })];
  const base = { now: NOW, appUrl: APP, email: "s1@example.edu", students: [student(1)], courses: [course], sessions, extensions: [] as never[] };
  assert.ok(planRecovery({ ...base, emailLog: [] }));
  const rows: EmailLogRow[] = [1, 2, 3].map((m) => ({ session_id: null, kind: "recovery", to_email: "s1@example.edu", student_id: null, status: "sent", created_at: iso(NOW.getTime() - m * 60_000) }));
  assert.equal(planRecovery({ ...base, emailLog: rows }), null);
  assert.equal(planRecovery({ ...base, students: [], emailLog: [] }), null);
  assert.equal(planRecovery({ ...base, sessions: [session({ opens_at: at(-24 * 400), closes_at: at(-24 * 399) })], emailLog: [] }), null);
});

Deno.test("normalizeEmail", () => {
  assert.equal(normalizeEmail("  Jane@Example.EDU "), "jane@example.edu");
  assert.equal(normalizeEmail("nope"), null);
  assert.equal(normalizeEmail(42), null);
  assert.equal(normalizeEmail("a@b.c".padEnd(300, "x")), null);
});

Deno.test("reminders: submit skips students past their deadline, honors extensions; results needs publication", () => {
  const s = session({ opens_at: at(-48), closes_at: at(-2), grace_minutes: 15 });
  const ext = [{ session_id: "se1", student_id: "st1", closes_at: at(5) }];
  const r = planReminders({ now: NOW, appUrl: APP, kind: "submit", course, session: s, students, extensions: ext });
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.emails.map((e) => e.studentId), ["st1"]);
    assert.equal(r.ignored, 2);
    assert.equal(r.emails[0].kind, "reminder");
  }
  const early = planReminders({ now: NOW, appUrl: APP, kind: "submit", course, session: session({ opens_at: at(1) }), students, extensions: [] });
  assert.deepEqual(early, { ok: false, error: "not_open_yet" });
  const np = planReminders({ now: NOW, appUrl: APP, kind: "results", course, session: session(), students, extensions: [] });
  assert.deepEqual(np, { ok: false, error: "not_published" });
  const pub = planReminders({ now: NOW, appUrl: APP, kind: "results", course, session: session({ published_at: at(-1) }), students, extensions: [] });
  assert.ok(pub.ok && pub.emails.length === 3 && pub.emails[0].text.includes("/results/se1"));
});

Deno.test("reminders: a student from another course is ignored", () => {
  const r = planReminders({ now: NOW, appUrl: APP, kind: "submit", course, session: session(), students: [student(1), student(9, "other")], extensions: [] });
  assert.ok(r.ok && r.emails.length === 1 && r.ignored === 1);
});

Deno.test("copyForInstructor keeps content and swaps recipient", () => {
  const r = planReminders({ now: NOW, appUrl: APP, kind: "submit", course, session: session(), students, extensions: [] });
  assert.ok(r.ok);
  if (r.ok) {
    const c = copyForInstructor(r.emails[0], "prof@x.edu", 3);
    assert.equal(c.to, "prof@x.edu");
    assert.equal(c.kind, "reminder_copy");
    assert.ok(c.subject.startsWith("[Copy]"));
    assert.ok(c.html.includes("Copy of the reminder sent to 3 students"));
  }
});

Deno.test("links and time zone formatting", () => {
  assert.equal(submitLink("https://a.io/r/", "T", "S"), "https://a.io/r/#/s/T/sessions/S");
  assert.equal(resultsLink("https://a.io/r", "T", "S"), "https://a.io/r/#/s/T/results/S");
  assert.equal(formatDeadline("2026-01-16T06:59:00Z", "America/Denver"), "Thu, Jan 15, 2026, 11:59 PM MST");
  assert.ok(formatDeadline("2026-01-16T06:59:00Z", "Not/AZone").includes("UTC"));
});

Deno.test("template without instructions omits the section", () => {
  const r = renderSessionEmail("published", { studentName: "A", courseCode: "C", courseName: "N", sessionName: "S", deadline: "d", instructions: "secret", link: "https://x/y" });
  assert.ok(!r.text.includes("secret"));
  assert.ok(!r.text.includes("Deadline"));
});

// ---- sending ----

const planned = (n: number): PlannedEmail[] => Array.from({ length: n }, (_, i) => ({
  kind: "opened", sessionId: "se1", studentId: `st${i}`, to: `s${i}@x.edu`, subject: "s", html: "<p>h</p>", text: "t",
}));

Deno.test("sendAll without a Resend key logs skipped for every email and does not call fetch", async () => {
  const rows: unknown[] = [];
  let calls = 0;
  const res = await sendAll(planned(3), { resend: null, log: (r) => { rows.push(r); return Promise.resolve(); }, fetchFn: (() => { calls++; return Promise.reject(new Error("no")); }) as unknown as typeof fetch });
  assert.equal(res.skipped, 3);
  assert.equal(res.processed, 3);
  assert.equal(calls, 0);
  assert.ok((rows as { status: string }[]).every((r) => r.status === "skipped"));
});

Deno.test("sendAll records failures and keeps going, pauses between sends", async () => {
  const rows: { status: string; error: string | null }[] = [];
  const sleeps: number[] = [];
  let n = 0;
  const fetchFn = (() => {
    n++;
    return Promise.resolve(n === 2
      ? new Response(JSON.stringify({ message: "bad address" }), { status: 422 })
      : new Response(JSON.stringify({ id: `m${n}` }), { status: 200 }));
  }) as unknown as typeof fetch;
  const res = await sendAll(planned(3), {
    resend: { apiKey: "k", from: "App <a@x.edu>" }, fetchFn, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    log: (r) => { rows.push(r); return Promise.resolve(); }, delayMs: 600,
  });
  assert.deepEqual([res.sent, res.failed, res.skipped, res.processed], [2, 1, 0, 3]);
  assert.deepEqual(rows.map((r) => r.status), ["sent", "failed", "sent"]);
  assert.ok(rows[1].error!.includes("bad address"));
  assert.deepEqual(sleeps, [600, 600]);
});

Deno.test("sendAll stops starting new emails after the deadline", async () => {
  let t = 0;
  const res = await sendAll(planned(5), {
    resend: null, log: () => Promise.resolve(), deadlineMs: 2, now: () => t++,
  });
  assert.equal(res.processed, 2);
});

Deno.test("Resend client retries once after 429", async () => {
  let n = 0;
  const fetchFn = (() => {
    n++;
    return Promise.resolve(n === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "1" } }) : new Response(JSON.stringify({ id: "ok" }), { status: 200 }));
  }) as unknown as typeof fetch;
  const r = await sendViaResend({ apiKey: "k", from: "f" }, { to: "a@b.c", subject: "s", html: "h", text: "t" }, { fetchFn, sleep: () => Promise.resolve() });
  assert.deepEqual(r, { ok: true, id: "ok" });
  assert.equal(n, 2);
});

Deno.test("Resend client never throws on network errors", async () => {
  const r = await sendViaResend({ apiKey: "k", from: "f" }, { to: "a@b.c", subject: "s", html: "h", text: "t" }, { fetchFn: (() => Promise.reject(new Error("down"))) as unknown as typeof fetch });
  assert.equal(r.ok, false);
  assert.ok(r.error!.includes("down"));
});

Deno.test("CORS: GitHub Pages origin from APP_URL and localhost are allowed, others are not", () => {
  const app = "https://prof.github.io/peer-feedback";
  assert.equal(allowedOrigin("https://prof.github.io", app), "https://prof.github.io");
  assert.equal(allowedOrigin("http://localhost:5173", app), "http://localhost:5173");
  assert.equal(allowedOrigin("https://evil.example", app), null);
  assert.equal(allowedOrigin(null, app), null);
});
