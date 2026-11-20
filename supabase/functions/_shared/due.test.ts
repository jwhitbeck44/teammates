// Unit tests for the pure due-email logic. Run: deno test supabase/functions/_shared/
import assert from "node:assert/strict";
import {
  copyForInstructor, normalizeEmail, studentSubmitDeadline, RECOVERY_GLOBAL_LIMIT, planDueEmails, planRecovery, planReminders, recoveryRateLimited,
  isPublished, type DueInput,
} from "./due.ts";
import { sendAll } from "./send.ts";
import { deliverRecovery } from "./recovery.ts";
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

Deno.test("submit deadline is greatest(extension, closes_at + grace), as SQL student_deadline", () => {
  const s = session({ closes_at: at(-0.2), grace_minutes: 15 }); // closed 12 minutes ago, grace still running
  const base = Date.parse(s.closes_at) + 15 * 60_000;
  assert.equal(studentSubmitDeadline(s, undefined), base);
  // an extension shorter than the grace period neither shortens nor replaces it
  assert.equal(studentSubmitDeadline(s, { session_id: "se1", student_id: "st1", closes_at: at(-1) }), base);
  // a longer extension wins
  assert.equal(studentSubmitDeadline(s, { session_id: "se1", student_id: "st1", closes_at: at(5) }), Date.parse(at(5)));
  // so a reminder still goes to a student whose short extension is already over while the grace period runs
  const r = planReminders({ now: NOW, appUrl: APP, kind: "submit", course, session: s, students: [student(1)],
    extensions: [{ session_id: "se1", student_id: "st1", closes_at: at(-1) }] });
  assert.ok(r.ok && r.emails.length === 1 && r.ignored === 0);
});

Deno.test("recovery rate limit counts pending rows (rows are written before sending)", () => {
  const row = (status: EmailLogRow["status"]): EmailLogRow =>
    ({ session_id: null, kind: "recovery", to_email: "a@x.edu", student_id: null, status, created_at: iso(NOW.getTime() - 60_000) });
  assert.equal(recoveryRateLimited(NOW, "a@x.edu", [row("pending"), row("pending"), row("pending")]), true);
  assert.equal(recoveryRateLimited(NOW, "a@x.edu", [row("pending"), row("pending")]), false);
  assert.equal(RECOVERY_GLOBAL_LIMIT, 200);
});

const recMail = (): PlannedEmail => ({ kind: "recovery", sessionId: null, studentId: null, to: "a@x.edu", subject: "s", html: "<p>h</p>", text: "t" });

Deno.test("deliverRecovery claims the slot before the send and records the result on that row", async () => {
  const events: string[] = [];
  const fetchFn = (() => { events.push("send"); return Promise.resolve(new Response(JSON.stringify({ id: "m1" }), { status: 200 })); }) as unknown as typeof fetch;
  const out = await deliverRecovery(recMail(), {
    resend: { apiKey: "k", from: "App <a@x.edu>" }, fetchFn,
    claim: () => { events.push("claim"); return Promise.resolve("row1"); },
    finish: (id, status) => { events.push(`finish:${id}:${status}`); return Promise.resolve(); },
  });
  assert.equal(out, "sent");
  assert.deepEqual(events, ["claim", "send", "finish:row1:sent"]);
});

Deno.test("deliverRecovery sends nothing when the limit refuses the claim", async () => {
  let sends = 0;
  const out = await deliverRecovery(recMail(), {
    resend: { apiKey: "k", from: "App <a@x.edu>" }, fetchFn: (() => { sends++; return Promise.reject(new Error("no")); }) as unknown as typeof fetch,
    claim: () => Promise.resolve(null),
    finish: () => Promise.reject(new Error("must not be called")),
  });
  assert.equal(out, "limited");
  assert.equal(sends, 0);
});

Deno.test("deliverRecovery: parallel requests get at most the allowed number of sends", async () => {
  // a claim function that behaves like claim_recovery_slot: one at a time, limit 3
  let claimed = 0;
  const claim = () => { if (claimed >= 3) return Promise.resolve(null); claimed++; return Promise.resolve(`row${claimed}`); };
  let sends = 0;
  const fetchFn = (() => { sends++; return Promise.resolve(new Response(JSON.stringify({ id: "m" }), { status: 200 })); }) as unknown as typeof fetch;
  const outs = await Promise.all(Array.from({ length: 20 }, () => deliverRecovery(recMail(), {
    resend: { apiKey: "k", from: "App <a@x.edu>" }, fetchFn, claim, finish: () => Promise.resolve(),
  })));
  assert.equal(outs.filter((o) => o === "sent").length, 3);
  assert.equal(outs.filter((o) => o === "limited").length, 17);
  assert.equal(sends, 3);
});

Deno.test("deliverRecovery records skipped and failed results on the claimed row", async () => {
  const seen: string[] = [];
  const finish = (_id: string, status: string) => { seen.push(status); return Promise.resolve(); };
  assert.equal(await deliverRecovery(recMail(), { resend: null, claim: () => Promise.resolve("r"), finish }), "skipped");
  const bad = (() => Promise.resolve(new Response(JSON.stringify({ message: "nope" }), { status: 422 }))) as unknown as typeof fetch;
  assert.equal(await deliverRecovery(recMail(), { resend: { apiKey: "k", from: "a@x.edu" }, fetchFn: bad, claim: () => Promise.resolve("r"), finish }), "failed");
  assert.deepEqual(seen, ["skipped", "failed"]);
});

// ---------------------------------------------------------------------------
// Second review fixes (BUILD_NOTES/09-second-review-fixes.md)
// ---------------------------------------------------------------------------
import { hasRecipients, logStates, MAX_EMAIL_ATTEMPTS, stampablePlans } from "./due.ts";
import { keyFromJson, pickKey } from "./keys.ts";
import { cronAuthorized, CRON_SECRET_HEADER } from "./http.ts";
import hasRecipientsFixture from "../../tests/fixtures/has_recipients_cases.json" with { type: "json" };

Deno.test("item 1: keys from SUPABASE_SECRET_KEYS / SUPABASE_PUBLISHABLE_KEYS, legacy variables as fallback", () => {
  assert.equal(keyFromJson('{"default":"sb_secret_abc","billing":"sb_secret_x"}'), "sb_secret_abc");
  assert.equal(keyFromJson('{"worker":"sb_secret_w"}'), "sb_secret_w", "no default: the first key");
  assert.equal(keyFromJson("not json"), null);
  assert.equal(keyFromJson('["sb_secret_abc"]'), null);
  assert.equal(keyFromJson('{"default":""}'), null);
  assert.equal(keyFromJson(undefined), null);
  assert.equal(pickKey('{"default":"sb_secret_abc"}', "eyJlegacy"), "sb_secret_abc", "new key wins");
  assert.equal(pickKey(undefined, "eyJlegacy"), "eyJlegacy", "legacy when the new variable is missing");
  assert.equal(pickKey("{broken", " eyJlegacy "), "eyJlegacy", "legacy when the new variable is not JSON");
  assert.equal(pickKey(undefined, ""), null);
});

Deno.test("item 1: the timer is authorized by x-cron-secret only, never by a bearer token", () => {
  const req = (headers: Record<string, string>) => new Request("https://x.supabase.co/functions/v1/email-dispatch", { method: "POST", headers });
  assert.equal(CRON_SECRET_HEADER, "x-cron-secret");
  assert.equal(cronAuthorized(req({ "x-cron-secret": "s3cret" }), "s3cret"), true);
  assert.equal(cronAuthorized(req({ "x-cron-secret": "wrong" }), "s3cret"), false);
  assert.equal(cronAuthorized(req({ "x-cron-secret": "s3cre" }), "s3cret"), false, "a prefix is not enough");
  assert.equal(cronAuthorized(req({}), "s3cret"), false, "no header");
  assert.equal(cronAuthorized(req({ Authorization: "Bearer s3cret" }), "s3cret"), false, "the old bearer check is gone");
  assert.equal(cronAuthorized(req({ "x-cron-secret": "" }), ""), false, "an unset CRON_SECRET never authorizes");
  assert.equal(cronAuthorized(req({ "x-cron-secret": "anything" }), undefined), false);
});

Deno.test("item 4: hasRecipients agrees with the shared fixture (same file as the web resolveRecipients test)", () => {
  const fx = hasRecipientsFixture as {
    rosters: Record<string, { id: string; section: string; team: string }[]>;
    cases: { roster: string; giver: string; recipient_type: string; instructors: number; expected: boolean }[];
  };
  for (const c of fx.cases) {
    const roster = fx.rosters[c.roster];
    const me = roster.find((s) => s.id === c.giver)!;
    assert.equal(hasRecipients(c.recipient_type, me, roster, c.instructors), c.expected, `${c.roster}/${c.giver}/${c.recipient_type}`);
  }
});

Deno.test("item 4: closing soon ignores a question with no recipients for the student (team of one)", () => {
  // st3 is alone in T2: the teammates question has no recipients for st3
  const roster: StudentRow[] = [
    { ...student(1), section: "S1", team: "T1" }, { ...student(2), section: "S1", team: "T1" }, { ...student(3), section: "S1", team: "T2" },
  ];
  const sess = session({ opens_at: at(-48), closes_at: at(10) });
  const questions = [
    { id: "q1", session_id: "se1", giver_type: "students" as const, recipient_type: "self" },
    { id: "q2", session_id: "se1", giver_type: "students" as const, recipient_type: "own_team_members" },
  ];
  const responses = [
    { session_id: "se1", question_id: "q1", giver_key: "s:st3" },
    { session_id: "se1", question_id: "q1", giver_key: "s:st1" },
  ];
  const plans = byKind(planDueEmails(input({ sessions: [sess], students: roster, questions, responses })), "closing");
  assert.deepEqual(plans[0].emails.map((e) => e.studentId), ["st1", "st2"], "st3 answered everything they can answer");
  // a question to instructors with no instructor shown to students does not count either
  const toInstructors = [{ id: "q3", session_id: "se1", giver_type: "students" as const, recipient_type: "instructors" }];
  const r2 = [{ session_id: "se1", question_id: "q3", giver_key: "s:st1" }];
  const none = byKind(planDueEmails(input({ sessions: [sess], students: roster, questions: toInstructors, responses: [], instructors: [] })), "closing");
  assert.equal(none.length === 0 || none[0].emails.length === 0, true, "no instructor shown: nobody is nagged");
  const some = byKind(planDueEmails(input({
    sessions: [sess], students: roster, questions: toInstructors, responses: r2,
    instructors: [{ course_id: "c1", is_displayed_to_students: true }],
  })), "closing");
  assert.deepEqual(some[0].emails.map((e) => e.studentId), ["st2", "st3"]);
});

Deno.test("item 5: logStates: sent, skipped and pending are done; failures count up to MAX_EMAIL_ATTEMPTS", () => {
  assert.equal(MAX_EMAIL_ATTEMPTS, 3);
  const st = logStates([
    log("opened", "st1", "failed"), log("opened", "st1", "failed"),
    log("opened", "st2", "failed"), log("opened", "st2", "sent"),
    log("opened", "st3", "skipped"),
    log("published", "st1", "failed"), log("published", "st1", "failed"), log("published", "st1", "failed"),
  ]);
  assert.deepEqual(st.get("opened|se1|st1"), { done: false, failures: 2 });
  assert.equal(st.get("opened|se1|st2")?.done, true);
  assert.equal(st.get("opened|se1|st3")?.done, true, "skipped (no provider) counts as done");
  assert.equal(st.get("published|se1|st1")?.done, true, "three failures: give up");
});

Deno.test("item 5: a failed send is planned again with the next attempt number, at most three attempts", () => {
  const plans = byKind(planDueEmails(input({
    emailLog: [log("opened", "st1", "failed"), log("opened", "st2", "failed"), log("opened", "st2", "failed"), log("opened", "st3", "skipped")],
  })), "opened");
  assert.deepEqual(plans[0].emails.map((e) => [e.studentId, e.attempt]), [["st1", 2], ["st2", 3]]);
  const after3 = byKind(planDueEmails(input({
    emailLog: ["st1", "st2", "st3"].flatMap((id) => [log("opened", id, "failed"), log("opened", id, "failed"), log("opened", id, "failed")]),
  })), "opened");
  assert.equal(after3[0].emails.length, 0, "every student had three failures: nothing more is sent");
  assert.equal(after3[0].stampNeeded, true);
  // closing soon and published retry the same way
  const closing = byKind(planDueEmails(input({ sessions: [session({ opens_at: at(-48), closes_at: at(10) })], emailLog: [log("closing", "st1", "failed")] })), "closing");
  assert.deepEqual(closing[0].emails.map((e) => [e.studentId, e.attempt]), [["st1", 2], ["st2", 1], ["st3", 1]]);
  const pub = byKind(planDueEmails(input({ sessions: [session({ published_at: at(-1) })], emailLog: [log("published", "st2", "failed"), log("published", "st1", "sent")] })), "published");
  assert.deepEqual(pub[0].emails.map((e) => [e.studentId, e.attempt]), [["st2", 2], ["st3", 1]]);
});

Deno.test("item 5: the stamp waits until nothing is left to retry", () => {
  const e = (attempt: number): PlannedEmail => ({ kind: "opened", sessionId: "se1", studentId: "x", to: "x@y.z", subject: "", html: "", text: "", attempt });
  const plan = (emails: PlannedEmail[], stampNeeded = true) => ({ sessionId: "se1", kind: "opened" as const, stampField: "opened_email_sent_at" as const, stampNeeded, emails });
  const ok = plan([e(1), e(1)]);
  assert.equal(stampablePlans([ok], ["sent", "skipped"]).length, 1, "all sent or skipped: stamp");
  assert.equal(stampablePlans([ok], ["sent", "failed"]).length, 0, "a first failure: no stamp, retried next run");
  assert.equal(stampablePlans([plan([e(2)])], ["failed"]).length, 0, "a second failure: no stamp");
  assert.equal(stampablePlans([plan([e(3)])], ["failed"]).length, 1, "the third failure: give up and stamp");
  assert.equal(stampablePlans([ok], ["sent"]).length, 0, "not every email attempted (time budget): no stamp");
  assert.equal(stampablePlans([plan([])], []).length, 1, "stamp-only plan");
  assert.equal(stampablePlans([plan([e(1)], false)], ["sent"]).length, 0, "no stamp needed");
  // offsets: the second plan's failure does not block the first plan
  const p1 = plan([e(1)]);
  const p2 = { ...plan([e(1)]), kind: "published" as const, stampField: "published_email_sent_at" as const };
  assert.deepEqual(stampablePlans([p1, p2], ["sent", "failed"]).map((p) => p.kind), ["opened"]);
});

Deno.test("item 5: sendAll reports one outcome per attempted email", async () => {
  const emails = [1, 2, 3].map((n): PlannedEmail => ({ kind: "opened", sessionId: "se1", studentId: `st${n}`, to: `s${n}@x.edu`, subject: "s", html: "h", text: "t" }));
  let n = 0;
  const fetchFn = (() => { n++; return Promise.resolve(new Response(n === 2 ? '{"message":"bad"}' : '{"id":"1"}', { status: n === 2 ? 422 : 200 })); }) as typeof fetch;
  const sum = await sendAll(emails, { resend: { apiKey: "k", from: "f@x.edu" }, log: async () => {}, fetchFn, sleep: async () => {} });
  assert.deepEqual(sum.outcomes, ["sent", "failed", "sent"]);
  const skipped = await sendAll(emails, { resend: null, log: async () => {} });
  assert.deepEqual(skipped.outcomes, ["skipped", "skipped", "skipped"]);
});
