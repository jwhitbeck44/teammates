// Row shapes used by the email logic. They mirror ARCHITECTURE.md section 5.
// Timestamps arrive from PostgREST as ISO strings.

export interface CourseRow {
  id: string;
  code: string;
  name: string;
  time_zone: string;
  archived_at: string | null;
}

export interface SessionRow {
  id: string;
  course_id: string;
  name: string;
  instructions: string;
  opens_at: string;
  closes_at: string;
  grace_minutes: number;
  results_visibility: "at_open" | "custom" | "later";
  results_visible_at: string | null;
  published_at: string | null;
  closing_email_enabled: boolean;
  published_email_enabled: boolean;
  opened_email_sent_at: string | null;
  closing_email_sent_at: string | null;
  published_email_sent_at: string | null;
}

export interface StudentRow {
  id: string;
  course_id: string;
  name: string;
  email: string;
  access_token: string;
}

export interface ExtensionRow {
  session_id: string;
  student_id: string;
  closes_at: string;
}

export interface QuestionRow {
  id: string;
  session_id: string;
  giver_type: "students" | "instructors";
}

export interface ResponseKeyRow {
  session_id: string;
  question_id: string;
  giver_key: string;
}

export interface EmailLogRow {
  session_id: string | null;
  kind: string;
  to_email: string;
  student_id: string | null;
  status: "sent" | "failed" | "skipped";
  created_at: string;
}

export type EmailKind =
  | "opened"
  | "closing"
  | "published"
  | "reminder"
  | "results_reminder"
  | "reminder_copy"
  | "recovery";

export interface PlannedEmail {
  kind: EmailKind;
  sessionId: string | null;
  studentId: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type StampField =
  | "opened_email_sent_at"
  | "closing_email_sent_at"
  | "published_email_sent_at";

/** The emails for one session and one automatic kind, plus the stamp to set once they were all attempted. */
export interface SessionPlan {
  sessionId: string;
  kind: "opened" | "closing" | "published";
  stampField: StampField;
  stampNeeded: boolean;
  emails: PlannedEmail[];
}
