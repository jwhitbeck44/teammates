// Due-email selection. Pure functions: rows in, emails out. No database, no network,
// no Deno globals, so these run under Deno and Node and are unit tested without a database.

import {
  formatDeadline,
  renderRecoveryEmail,
  renderSessionEmail,
  resultsLink,
  submitLink,
} from "./templates.ts";
import type {
  CourseRow,
  EmailLogRow,
  ExtensionRow,
  InstructorPresenceRow,
  PlannedEmail,
  QuestionRow,
  ResponseKeyRow,
  SessionPlan,
  SessionRow,
  StudentRow,
} from "./types.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Opened email only for sessions that opened within this long ago (ARCHITECTURE.md section 10). */
export const OPENED_WINDOW_MS = 2 * DAY;
/** Closing-soon email goes out this long before a student's deadline. */
export const CLOSING_LEAD_MS = DAY;
/** Published email is skipped (stamped without sending) when results were published longer ago than this. */
export const PUBLISHED_WINDOW_MS = 7 * DAY;
/** Recovery rate limit: at most this many per email per hour. */
export const RECOVERY_LIMIT = 3;
export const RECOVERY_WINDOW_MS = HOUR;
/** Recovery emails per hour across all addresses (claim_recovery_slot enforces it in SQL). */
export const RECOVERY_GLOBAL_LIMIT = 200;
export const RECOVERY_LOOKBACK_MS = 180 * DAY;

/** Automatic emails (opened, closing, published): a failed send is tried again on later runs, up to this many attempts per student, session and kind. */
export const MAX_EMAIL_ATTEMPTS = 3;

const t = (iso: string) => Date.parse(iso);

/** `session_is_published` from ARCHITECTURE.md section 5. */
export function isPublished(s: SessionRow, now: Date): boolean {
  if (s.published_at !== null) return true;
  if (s.results_visibility === "at_open") return now.getTime() >= t(s.opens_at);
  if (s.results_visibility === "custom") {
    return s.results_visible_at !== null && now.getTime() >= t(s.results_visible_at);
  }
  return false;
}

/** The moment results became visible, or null when not published. */
export function publishedSince(s: SessionRow, now: Date): number | null {
  if (!isPublished(s, now)) return null;
  const times: number[] = [];
  if (s.published_at !== null) times.push(t(s.published_at));
  if (s.results_visibility === "at_open") times.push(t(s.opens_at));
  if (s.results_visibility === "custom" && s.results_visible_at !== null) times.push(t(s.results_visible_at));
  return Math.min(...times);
}

/** Per-student deadline for submitting: greatest(extension, closes_at + grace), as SQL student_deadline (ARCHITECTURE.md section 5). */
export function studentSubmitDeadline(s: SessionRow, ext: ExtensionRow | undefined): number {
  const base = t(s.closes_at) + s.grace_minutes * 60_000;
  return ext ? Math.max(t(ext.closes_at), base) : base;
}

/** Per-student deadline shown in emails: the extension if present, else closes_at (no grace). */
export function studentShownDeadline(s: SessionRow, ext: ExtensionRow | undefined): string {
  return ext ? ext.closes_at : s.closes_at;
}

export interface DueInput {
  now: Date;
  appUrl: string;
  courses: CourseRow[];
  sessions: SessionRow[];
  students: StudentRow[];
  extensions: ExtensionRow[];
  /** Questions of the sessions above. Only giver_type 'students' matters. */
  questions: QuestionRow[];
  /** One row per response (question_id, giver_key) of the sessions above. */
  responses: ResponseKeyRow[];
  /** Existing email_log rows for the sessions above (any kind, any status). */
  emailLog: EmailLogRow[];
  /** course_instructors rows of the courses above, for questions to instructors. Absent: assume some are shown. */
  instructors?: InstructorPresenceRow[];
}

function logKey(kind: string, sessionId: string | null, studentId: string | null): string {
  return `${kind}|${sessionId}|${studentId}`;
}

/**
 * What the email log says about one student, session and kind: done (a sent, skipped or pending row), or the
 * number of failed attempts so far. Skipped (no email provider) counts as done, so adding a provider later
 * does not email old sessions. MAX_EMAIL_ATTEMPTS failures also count as done.
 */
export interface LogState {
  done: boolean;
  failures: number;
}

export function logStates(rows: readonly EmailLogRow[]): Map<string, LogState> {
  const out = new Map<string, LogState>();
  for (const l of rows) {
    const k = logKey(l.kind, l.session_id, l.student_id);
    const st = out.get(k) ?? { done: false, failures: 0 };
    if (l.status === "failed") st.failures++;
    else st.done = true;
    out.set(k, st);
  }
  for (const st of out.values()) if (st.failures >= MAX_EMAIL_ATTEMPTS) st.done = true;
  return out;
}

/**
 * Whether a student-giver question has at least one recipient for this student. Mirror of
 * resolveRecipients() in web/src/lib/recipients.ts and question_recipients() in SQL, reduced to "any?".
 * Shared cases: supabase/tests/fixtures/has_recipients_cases.json. When the student's team or the question's
 * recipient type is unknown, the answer is true (the question counts).
 */
export function hasRecipients(
  recipientType: string | undefined,
  me: Pick<StudentRow, "id" | "section" | "team">,
  courseStudents: readonly Pick<StudentRow, "id" | "section" | "team">[],
  displayedInstructors: number,
): boolean {
  const known = me.section !== undefined && me.team !== undefined;
  const teamOf = (s: Pick<StudentRow, "section" | "team">) => `${s.section}|${s.team}`;
  switch (recipientType) {
    case "students_excluding_self":
      return courseStudents.some((s) => s.id !== me.id);
    case "teams_excluding_self":
      return !known || courseStudents.some((s) => s.section !== undefined && teamOf(s) !== teamOf(me));
    case "own_team_members":
      return !known || courseStudents.some((s) => s.id !== me.id && teamOf(s) === teamOf(me));
    case "instructors":
      return displayedInstructors > 0;
    default:
      // self, none, students, teams, own_team, own_team_members_including_self: the giver or the giver's team is always there
      return true;
  }
}

/**
 * Plans whose stamp may be set after a run. A plan is stampable when it needs a stamp, every one of its emails
 * was attempted in this run, and none of them failed with attempts left (those are retried on the next run,
 * which needs the stamp unset). `outcomes` are the results of sendAll, in the order of the flattened emails.
 */
export function stampablePlans(plans: readonly SessionPlan[], outcomes: readonly ("sent" | "failed" | "skipped")[]): SessionPlan[] {
  const out: SessionPlan[] = [];
  let offset = 0;
  for (const p of plans) {
    const start = offset;
    offset += p.emails.length;
    if (!p.stampNeeded) continue;
    if (offset > outcomes.length) continue;
    const retryLeft = p.emails.some((e, i) => outcomes[start + i] === "failed" && (e.attempt ?? 1) < MAX_EMAIL_ATTEMPTS);
    if (!retryLeft) out.push(p);
  }
  return out;
}

/**
 * Select the automatic emails (opened, closing soon, published) that are due at `now`.
 * Returns one plan per session and kind. A plan with `stampNeeded` and no emails means
 * "just set the stamp". The caller sends the emails, then sets the stamps that stampablePlans()
 * allows. A student is skipped when the email_log row for the same kind and session says done
 * (sent, skipped, or MAX_EMAIL_ATTEMPTS failures); after fewer failures the email is planned again
 * with the next attempt number. So a half-finished run can be resumed safely, and failures are retried.
 */
export function planDueEmails(input: DueInput): SessionPlan[] {
  const { now, appUrl } = input;
  const nowMs = now.getTime();
  const courses = new Map(input.courses.map((c) => [c.id, c]));
  const studentsByCourse = new Map<string, StudentRow[]>();
  for (const st of input.students) {
    const list = studentsByCourse.get(st.course_id) ?? [];
    list.push(st);
    studentsByCourse.set(st.course_id, list);
  }
  const extByKey = new Map(input.extensions.map((e) => [`${e.session_id}|${e.student_id}`, e]));
  const states = logStates(input.emailLog);
  const isDone = (kind: string, sessionId: string, studentId: string) => states.get(logKey(kind, sessionId, studentId))?.done ?? false;
  const attemptOf = (kind: string, sessionId: string, studentId: string) => (states.get(logKey(kind, sessionId, studentId))?.failures ?? 0) + 1;
  const answered = new Set(input.responses.map((r) => `${r.session_id}|${r.question_id}|${r.giver_key}`));
  const studentQuestions = new Map<string, QuestionRow[]>();
  for (const q of input.questions) {
    if (q.giver_type !== "students") continue;
    const list = studentQuestions.get(q.session_id) ?? [];
    list.push(q);
    studentQuestions.set(q.session_id, list);
  }
  const shownInstructors = new Map<string, number>();
  for (const i of input.instructors ?? []) {
    if (i.is_displayed_to_students) shownInstructors.set(i.course_id, (shownInstructors.get(i.course_id) ?? 0) + 1);
  }
  const instructorsShown = (courseId: string) => (input.instructors === undefined ? 1 : shownInstructors.get(courseId) ?? 0);

  /** Every question the student can answer (it has recipients for them) has at least one saved row. */
  const submittedAll = (s: SessionRow, st: StudentRow): boolean => {
    const qs = studentQuestions.get(s.id) ?? [];
    const roster = studentsByCourse.get(s.course_id) ?? [];
    return qs
      .filter((q) => hasRecipients(q.recipient_type, st, roster, instructorsShown(s.course_id)))
      .every((q) => answered.has(`${s.id}|${q.id}|s:${st.id}`));
  };

  const plans: SessionPlan[] = [];

  for (const s of input.sessions) {
    const course = courses.get(s.course_id);
    if (!course || course.archived_at !== null) continue;
    const students = studentsByCourse.get(s.course_id) ?? [];
    const opens = t(s.opens_at);
    const closes = t(s.closes_at);

    const render = (kind: "opened" | "closing" | "published", st: StudentRow, deadlineIso: string): PlannedEmail => {
      const link = kind === "published"
        ? resultsLink(appUrl, st.access_token, s.id)
        : submitLink(appUrl, st.access_token, s.id);
      const r = renderSessionEmail(kind, {
        studentName: st.name,
        courseCode: course.code,
        courseName: course.name,
        sessionName: s.name,
        deadline: formatDeadline(deadlineIso, course.time_zone),
        instructions: s.instructions,
        link,
      });
      return { kind, sessionId: s.id, studentId: st.id, to: st.email, attempt: attemptOf(kind, s.id, st.id), ...r };
    };

    // Opened
    if (
      s.opened_email_sent_at === null &&
      opens <= nowMs && nowMs < closes &&
      opens > nowMs - OPENED_WINDOW_MS
    ) {
      const emails = students
        .filter((st) => !isDone("opened", s.id, st.id))
        .map((st) => render("opened", st, studentShownDeadline(s, extByKey.get(`${s.id}|${st.id}`))));
      plans.push({ sessionId: s.id, kind: "opened", stampField: "opened_email_sent_at", stampNeeded: true, emails });
    }

    // Closing soon, per student so deadline extensions are handled
    if (s.closing_email_enabled && closes - opens > DAY && opens <= nowMs) {
      const emails: PlannedEmail[] = [];
      for (const st of students) {
        const ext = extByKey.get(`${s.id}|${st.id}`);
        const deadline = ext ? t(ext.closes_at) : closes;
        if (nowMs >= deadline || nowMs < deadline - CLOSING_LEAD_MS) continue;
        if (submittedAll(s, st)) continue;
        if (isDone("closing", s.id, st.id)) continue;
        emails.push(render("closing", st, studentShownDeadline(s, ext)));
      }
      const stampNeeded = s.closing_email_sent_at === null && nowMs >= closes - CLOSING_LEAD_MS;
      if (emails.length > 0 || stampNeeded) {
        plans.push({ sessionId: s.id, kind: "closing", stampField: "closing_email_sent_at", stampNeeded, emails });
      }
    }

    // Published
    if (s.published_email_enabled && s.published_email_sent_at === null && isPublished(s, now)) {
      const since = publishedSince(s, now) as number;
      const stale = nowMs - since > PUBLISHED_WINDOW_MS;
      const emails = stale
        ? []
        : students
          .filter((st) => !isDone("published", s.id, st.id))
          .map((st) => render("published", st, s.closes_at));
      plans.push({ sessionId: s.id, kind: "published", stampField: "published_email_sent_at", stampNeeded: true, emails });
    }
  }
  return plans;
}

/** Recovery rate limit: true when this email already got RECOVERY_LIMIT or more recovery rows (any status, pending included) in the last hour. */
export function recoveryRateLimited(now: Date, email: string, log: EmailLogRow[]): boolean {
  const since = now.getTime() - RECOVERY_WINDOW_MS;
  const n = log.filter((l) => l.kind === "recovery" && l.to_email === email && t(l.created_at) > since).length;
  return n >= RECOVERY_LIMIT;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length === 0 || e.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

export interface RecoveryInput {
  now: Date;
  appUrl: string;
  /** Normalized (lowercase, trimmed) address that was asked for. */
  email: string;
  /** Student rows whose email equals `email`, across courses. */
  students: StudentRow[];
  courses: CourseRow[];
  sessions: SessionRow[];
  extensions: ExtensionRow[];
  /** email_log rows with kind 'recovery' for this address (older ones are ignored). */
  emailLog: EmailLogRow[];
}

/**
 * Plan the link recovery email. Returns null when nothing should be sent: rate limited,
 * unknown address, or no session opened in the last 180 days. The caller answers {ok: true} in all cases.
 */
export function planRecovery(input: RecoveryInput): PlannedEmail | null {
  const { now, appUrl, email } = input;
  const nowMs = now.getTime();
  if (recoveryRateLimited(now, email, input.emailLog)) return null;
  const courses = new Map(input.courses.map((c) => [c.id, c]));
  const extByKey = new Map(input.extensions.map((e) => [`${e.session_id}|${e.student_id}`, e]));
  const out: { code: string; name: string; items: import("./templates.ts").RecoveryItem[]; sortKey: string }[] = [];

  for (const st of input.students) {
    const course = courses.get(st.course_id);
    if (!course || course.archived_at !== null) continue;
    const items = input.sessions
      .filter((s) => s.course_id === st.course_id)
      .filter((s) => t(s.opens_at) <= nowMs && t(s.opens_at) >= nowMs - RECOVERY_LOOKBACK_MS)
      .sort((a, b) => t(a.opens_at) - t(b.opens_at))
      .map((s) => ({
        sessionName: s.name,
        deadline: formatDeadline(studentShownDeadline(s, extByKey.get(`${s.id}|${st.id}`)), course.time_zone),
        submitLink: submitLink(appUrl, st.access_token, s.id),
        resultsLink: isPublished(s, now) ? resultsLink(appUrl, st.access_token, s.id) : null,
      }));
    if (items.length > 0) out.push({ code: course.code, name: course.name, items, sortKey: course.code });
  }
  if (out.length === 0) return null;
  out.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const r = renderRecoveryEmail(
    input.students[0].name,
    email,
    out.map((o) => ({ courseCode: o.code, courseName: o.name, items: o.items })),
  );
  return { kind: "recovery", sessionId: null, studentId: null, to: email, ...r };
}

export interface ReminderInput {
  now: Date;
  appUrl: string;
  kind: "submit" | "results";
  course: CourseRow;
  session: SessionRow;
  /** The selected students (already limited to the session's course). */
  students: StudentRow[];
  extensions: ExtensionRow[];
}

export type ReminderPlan =
  | { ok: true; emails: PlannedEmail[]; ignored: number }
  | { ok: false; error: "not_open_yet" | "not_published" };

/** Plan manual reminders. 'submit' needs an opened session and skips students whose deadline passed. */
export function planReminders(input: ReminderInput): ReminderPlan {
  const { now, appUrl, kind, course, session: s } = input;
  const nowMs = now.getTime();
  if (kind === "submit" && nowMs < t(s.opens_at)) return { ok: false, error: "not_open_yet" };
  if (kind === "results" && !isPublished(s, now)) return { ok: false, error: "not_published" };
  const extByStudent = new Map(input.extensions.filter((e) => e.session_id === s.id).map((e) => [e.student_id, e]));
  const emails: PlannedEmail[] = [];
  let ignored = 0;
  for (const st of input.students) {
    if (st.course_id !== s.course_id) { ignored++; continue; }
    const ext = extByStudent.get(st.id);
    if (kind === "submit" && nowMs >= studentSubmitDeadline(s, ext)) { ignored++; continue; }
    const emailKind = kind === "submit" ? "reminder" : "results_reminder";
    const link = kind === "submit"
      ? submitLink(appUrl, st.access_token, s.id)
      : resultsLink(appUrl, st.access_token, s.id);
    const r = renderSessionEmail(emailKind, {
      studentName: st.name,
      courseCode: course.code,
      courseName: course.name,
      sessionName: s.name,
      deadline: formatDeadline(studentShownDeadline(s, ext), course.time_zone),
      instructions: s.instructions,
      link,
    });
    emails.push({ kind: emailKind, sessionId: s.id, studentId: st.id, to: st.email, ...r });
  }
  return { ok: true, emails, ignored };
}

/** A copy of the first reminder for the instructor who sent it. */
export function copyForInstructor(first: PlannedEmail, instructorEmail: string, count: number): PlannedEmail {
  const note = `Copy of the reminder sent to ${count} student${count === 1 ? "" : "s"}. The link below is the one for ${first.to}.`;
  return {
    ...first,
    kind: "reminder_copy",
    studentId: null,
    to: instructorEmail,
    subject: `[Copy] ${first.subject}`,
    text: `${note}\n\n${first.text}`,
    html: first.html.replace(/(<body[^>]*>)/, `$1<p><i>${note.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</i></p>`),
  };
}
