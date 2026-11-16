// Email templates: plain functions that return subject, HTML and text.
// Wording follows the TEAMMATES templates (userEmailTemplate-*.html), shortened.
// No network and no Deno globals, so this file also runs under Node.

import type { EmailKind } from "./types.ts";

export interface EmailContext {
  studentName: string;
  courseCode: string;
  courseName: string;
  sessionName: string;
  /** Already formatted in the course time zone, e.g. "Fri, Nov 14, 2026, 11:59 PM MST". */
  deadline: string;
  instructions?: string;
  /** Personal link for this student and session. */
  link: string;
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export function submitLink(appUrl: string, token: string, sessionId: string): string {
  return `${trimSlashes(appUrl)}/#/s/${token}/sessions/${sessionId}`;
}

export function resultsLink(appUrl: string, token: string, sessionId: string): string {
  return `${trimSlashes(appUrl)}/#/s/${token}/results/${sessionId}`;
}

/** Format an instant in a time zone. Falls back to UTC if the zone name is not valid. */
export function formatDeadline(iso: string | Date, timeZone: string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(d);
  }
}

interface Copy {
  subjectPrefix: string;
  intro: string;
  action: string;
  deadlineLabel: string | null;
  showInstructions: boolean;
}

const COPY: Record<string, Copy> = {
  opened: {
    subjectPrefix: "Feedback session open",
    intro: "The following feedback session is now open.",
    action: "To submit your feedback, go to this link",
    deadlineLabel: "Deadline",
    showInstructions: true,
  },
  closing: {
    subjectPrefix: "Feedback session closing soon",
    intro:
      "A gentle reminder that the following feedback session is closing soon. No action is needed if you have already submitted everything.",
    action: "To submit or update your feedback, go to this link",
    deadlineLabel: "Deadline",
    showInstructions: true,
  },
  reminder: {
    subjectPrefix: "Reminder: feedback session",
    intro:
      "Your instructor asks you to complete the following feedback session. No action is needed if you have already submitted everything.",
    action: "To submit or update your feedback, go to this link",
    deadlineLabel: "Deadline",
    showInstructions: true,
  },
  published: {
    subjectPrefix: "Feedback session results available",
    intro: "The results of the following feedback session are now available.",
    action: "To view the results, go to this link",
    deadlineLabel: null,
    showInstructions: false,
  },
  results_reminder: {
    subjectPrefix: "Feedback session results available",
    intro: "Your instructor reminds you that the results of the following feedback session are available.",
    action: "To view the results, go to this link",
    deadlineLabel: null,
    showInstructions: false,
  },
};

/** Render one of: opened, closing, reminder, published, results_reminder. */
export function renderSessionEmail(kind: EmailKind, ctx: EmailContext): Rendered {
  const c = COPY[kind];
  if (!c) throw new Error(`No template for email kind ${kind}`);
  const subject = `${c.subjectPrefix}: ${ctx.sessionName} [${ctx.courseCode}]`;
  const instructions = c.showInstructions && ctx.instructions && ctx.instructions.trim() !== ""
    ? ctx.instructions.trim()
    : null;

  const textLines = [
    `Hello ${ctx.studentName},`,
    "",
    c.intro,
    "",
    `Course: [${ctx.courseCode}] ${ctx.courseName}`,
    `Feedback session: ${ctx.sessionName}`,
  ];
  if (c.deadlineLabel) textLines.push(`${c.deadlineLabel}: ${ctx.deadline}`);
  if (instructions) textLines.push("", "Session instructions:", instructions);
  textLines.push(
    "",
    `${c.action}:`,
    ctx.link,
    "",
    "This link is unique to you. Please do not share it with others.",
    "",
    "Questions about the session: contact your course instructors.",
  );

  const rows: string[] = [
    `<tr><td style="padding:2px 12px 2px 0"><b>Course</b></td><td>[${escapeHtml(ctx.courseCode)}] ${escapeHtml(ctx.courseName)}</td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0"><b>Feedback session</b></td><td>${escapeHtml(ctx.sessionName)}</td></tr>`,
  ];
  if (c.deadlineLabel) {
    rows.push(
      `<tr><td style="padding:2px 12px 2px 0"><b>${c.deadlineLabel}</b></td><td>${escapeHtml(ctx.deadline)}</td></tr>`,
    );
  }
  const instructionsHtml = instructions
    ? `<p><b>Session instructions</b><br>${escapeHtml(instructions).replace(/\r?\n/g, "<br>")}</p>`
    : "";
  const link = escapeHtml(ctx.link);
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222">
<p>Hello ${escapeHtml(ctx.studentName)},</p>
<p>${escapeHtml(c.intro)}</p>
<table style="border-collapse:collapse">${rows.join("")}</table>
${instructionsHtml}
<p>${escapeHtml(c.action)}:<br><a href="${link}">${link}</a></p>
<p>This link is unique to you. Please do not share it with others.</p>
<p>Questions about the session: contact your course instructors.</p>
</body></html>`;

  return { subject, html, text: textLines.join("\n") };
}

export interface RecoveryItem {
  sessionName: string;
  /** Deadline formatted in the course time zone. */
  deadline: string;
  submitLink: string;
  resultsLink: string | null;
}

export interface RecoveryCourse {
  courseCode: string;
  courseName: string;
  items: RecoveryItem[];
}

export function renderRecoveryEmail(studentName: string, email: string, courses: RecoveryCourse[]): Rendered {
  const subject = "Your feedback session links";
  const text: string[] = [
    `Hello ${studentName},`,
    "",
    `You are receiving this email because a request to resend feedback session links for ${email} was made.`,
    "Here are the sessions associated with this email address within the past 180 days:",
    "",
  ];
  const html: string[] = [
    `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222">`,
    `<p>Hello ${escapeHtml(studentName)},</p>`,
    `<p>You are receiving this email because a request to resend feedback session links for ${escapeHtml(email)} was made.</p>`,
    `<p>Here are the sessions associated with this email address within the past 180 days:</p>`,
  ];
  for (const course of courses) {
    text.push(`[${course.courseCode}] ${course.courseName}`);
    html.push(`<h4 style="margin-bottom:4px">[${escapeHtml(course.courseCode)}] ${escapeHtml(course.courseName)}</h4><ul>`);
    for (const it of course.items) {
      text.push(`  ${it.sessionName} (deadline ${it.deadline})`, `    Submit: ${it.submitLink}`);
      let li = `<li>${escapeHtml(it.sessionName)} (deadline ${escapeHtml(it.deadline)})<br>Submit: <a href="${escapeHtml(it.submitLink)}">${escapeHtml(it.submitLink)}</a>`;
      if (it.resultsLink) {
        text.push(`    Results: ${it.resultsLink}`);
        li += `<br>Results: <a href="${escapeHtml(it.resultsLink)}">${escapeHtml(it.resultsLink)}</a>`;
      }
      html.push(li + "</li>");
    }
    text.push("");
    html.push("</ul>");
  }
  text.push(
    "If a session you expected is missing, it may be linked to a different email address, or it opened more than 180 days ago. Contact your course instructors.",
    "",
    "These links are unique to you. Please do not share them with others.",
  );
  html.push(
    `<p>If a session you expected is missing, it may be linked to a different email address, or it opened more than 180 days ago. Contact your course instructors.</p>`,
    `<p>These links are unique to you. Please do not share them with others.</p></body></html>`,
  );
  return { subject, html: html.join("\n"), text: text.join("\n") };
}
