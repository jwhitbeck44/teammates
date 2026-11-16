// Shared types. Row types mirror ARCHITECTURE.md section 5; question, details and
// answer types mirror section 6. No React, no network.

export type Uuid = string;
/** ISO 8601 timestamp string (UTC) as returned by Postgres/PostgREST. */
export type Timestamp = string;

// ---------------------------------------------------------------------------
// Enums as string unions, with runtime lists for validation and UI.

export const INSTRUCTOR_ROLES = ['coowner', 'manager', 'observer', 'tutor'] as const;
export type InstructorRole = (typeof INSTRUCTOR_ROLES)[number];

export const PERMISSIONS = [
  'modify_course',
  'modify_instructors',
  'modify_sessions',
  'modify_students',
  'view_results',
  'submit',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<InstructorRole, Record<Permission, boolean>> = {
  coowner: {
    modify_course: true,
    modify_instructors: true,
    modify_sessions: true,
    modify_students: true,
    view_results: true,
    submit: true,
  },
  manager: {
    modify_course: false,
    modify_instructors: true,
    modify_sessions: true,
    modify_students: true,
    view_results: true,
    submit: true,
  },
  observer: {
    modify_course: false,
    modify_instructors: false,
    modify_sessions: false,
    modify_students: false,
    view_results: true,
    submit: false,
  },
  tutor: {
    modify_course: false,
    modify_instructors: false,
    modify_sessions: false,
    modify_students: false,
    view_results: true,
    submit: true,
  },
};

export const QUESTION_TYPES = [
  'text',
  'mcq',
  'msq',
  'numscale',
  'constsum_options',
  'constsum_recipients',
  'contrib',
  'rubric',
  'rank_options',
  'rank_recipients',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const GIVER_TYPES = ['students', 'instructors'] as const;
export type GiverType = (typeof GIVER_TYPES)[number];

export const RECIPIENT_TYPES = [
  'self',
  'students',
  'students_excluding_self',
  'teams',
  'teams_excluding_self',
  'own_team',
  'own_team_members',
  'own_team_members_including_self',
  'instructors',
  'none',
] as const;
export type RecipientType = (typeof RECIPIENT_TYPES)[number];

export const VISIBILITY_TYPES = [
  'recipient',
  'giver_team_members',
  'recipient_team_members',
  'students',
  'instructors',
] as const;
export type VisibilityType = (typeof VISIBILITY_TYPES)[number];

export const RESULTS_VISIBILITIES = ['at_open', 'custom', 'later'] as const;
export type ResultsVisibility = (typeof RESULTS_VISIBILITIES)[number];

export const DISTRIBUTE_MODES = ['none', 'some', 'all'] as const;
export type DistributeMode = (typeof DISTRIBUTE_MODES)[number];

export type EmailStatus = 'sent' | 'failed' | 'skipped';

// ---------------------------------------------------------------------------
// Database rows (section 5)

export interface InstructorAllowlistRow {
  email: string;
}

export interface Course {
  id: Uuid;
  code: string;
  name: string;
  institute: string | null;
  time_zone: string;
  archived_at: Timestamp | null;
  created_by: Uuid | null;
  created_at: Timestamp;
}

export interface CourseInstructor {
  id: Uuid;
  course_id: Uuid;
  email: string;
  user_id: Uuid | null;
  display_name: string;
  role: InstructorRole;
  is_displayed_to_students: boolean;
  created_at: Timestamp;
}

export interface Student {
  id: Uuid;
  course_id: Uuid;
  section: string;
  team: string;
  name: string;
  email: string;
  comments: string | null;
  access_token: string;
  created_at: Timestamp;
}

export interface Session {
  id: Uuid;
  course_id: Uuid;
  name: string;
  instructions: string;
  opens_at: Timestamp;
  closes_at: Timestamp;
  grace_minutes: number;
  results_visibility: ResultsVisibility;
  results_visible_at: Timestamp | null;
  published_at: Timestamp | null;
  closing_email_enabled: boolean;
  published_email_enabled: boolean;
  opened_email_sent_at: Timestamp | null;
  closing_email_sent_at: Timestamp | null;
  published_email_sent_at: Timestamp | null;
  created_by: Uuid | null;
  created_at: Timestamp;
}

export interface DeadlineExtension {
  session_id: Uuid;
  student_id: Uuid;
  closes_at: Timestamp;
}

export interface EmailLog {
  id: Uuid;
  session_id: Uuid | null;
  kind: string;
  to_email: string;
  student_id: Uuid | null;
  status: EmailStatus;
  error: string | null;
  created_at: Timestamp;
}

// ---------------------------------------------------------------------------
// Question details (section 6)

export interface TextDetails {
  recommendedLength?: number;
}
export interface McqDetails {
  choices: string[];
  otherEnabled: boolean;
}
export interface MsqDetails {
  choices: string[];
  otherEnabled: boolean;
  minSelectable?: number;
  maxSelectable?: number;
}
export interface NumscaleDetails {
  min: number;
  max: number;
  step: number;
}
export interface ConstsumOptionsDetails {
  options: string[];
  points: number;
  pointsPerOption: boolean;
  distribute: DistributeMode;
  minPoint?: number;
  maxPoint?: number;
}
export interface ConstsumRecipientsDetails {
  points: number;
  pointsPerOption: boolean;
  distribute: DistributeMode;
  minPoint?: number;
  maxPoint?: number;
}
export interface ContribDetails {
  isZeroSum: boolean;
  isNotSureAllowed: boolean;
}
export interface RubricDetails {
  choices: string[];
  subQuestions: string[];
  /** descriptions[subQuestionIndex][choiceIndex] */
  descriptions: string[][];
}
export interface RankOptionsDetails {
  options: string[];
  minToRank?: number;
  maxToRank?: number;
  duplicatesAllowed: boolean;
}
export interface RankRecipientsDetails {
  minToRank?: number;
  maxToRank?: number;
  duplicatesAllowed: boolean;
}

export interface DetailsByType {
  text: TextDetails;
  mcq: McqDetails;
  msq: MsqDetails;
  numscale: NumscaleDetails;
  constsum_options: ConstsumOptionsDetails;
  constsum_recipients: ConstsumRecipientsDetails;
  contrib: ContribDetails;
  rubric: RubricDetails;
  rank_options: RankOptionsDetails;
  rank_recipients: RankRecipientsDetails;
}

// ---------------------------------------------------------------------------
// Answers (one per response row)

export interface TextAnswer {
  text: string;
}
/** Exactly one of `choice` (a listed choice) or `other` (free text, needs otherEnabled). */
export interface McqAnswer {
  choice?: string;
  other?: string;
}
export interface MsqAnswer {
  choices: string[];
  other?: string;
}
export interface NumscaleAnswer {
  value: number;
}
export interface ConstsumOptionsAnswer {
  points: number[];
}
export interface ConstsumRecipientsAnswer {
  points: number;
}
export interface ContribAnswer {
  value: number;
}
export interface RubricAnswer {
  /** One index per sub-question, -1 = unanswered. */
  choices: number[];
}
export interface RankOptionsAnswer {
  /** Aligned with options; null = not ranked. */
  ranks: (number | null)[];
}
export interface RankRecipientsAnswer {
  rank: number;
}

export interface AnswerByType {
  text: TextAnswer;
  mcq: McqAnswer;
  msq: MsqAnswer;
  numscale: NumscaleAnswer;
  constsum_options: ConstsumOptionsAnswer;
  constsum_recipients: ConstsumRecipientsAnswer;
  contrib: ContribAnswer;
  rubric: RubricAnswer;
  rank_options: RankOptionsAnswer;
  rank_recipients: RankRecipientsAnswer;
}

export type Answer = AnswerByType[QuestionType];

/** Special contrib value: "Not sure". */
export const CONTRIB_NOT_SURE = -101;
export const RUBRIC_UNANSWERED = -1;

// ---------------------------------------------------------------------------
// Questions

/** Fields shared by every question (without type-specific details, id and session). */
export interface QuestionFields {
  number: number;
  brief: string;
  description: string;
  giver_type: GiverType;
  recipient_type: RecipientType;
  /** null = unlimited */
  max_recipients: number | null;
  show_responses_to: VisibilityType[];
  show_giver_name_to: VisibilityType[];
  show_recipient_name_to: VisibilityType[];
}

type DraftOf<T extends QuestionType> = QuestionFields & { type: T; details: DetailsByType[T] };

/** A question as edited or stored in templates: no id, no session. Discriminated by `type`. */
export type QuestionDraft = { [T in QuestionType]: DraftOf<T> }[QuestionType];

export type QuestionDraftOf<T extends QuestionType> = DraftOf<T>;

/** A stored question row. Discriminated by `type`. */
export type Question = QuestionDraft & { id: Uuid; session_id: Uuid };

export type QuestionOf<T extends QuestionType> = DraftOf<T> & { id: Uuid; session_id: Uuid };

// ---------------------------------------------------------------------------
// Responses and recipients

export interface ResponseRow {
  id: Uuid;
  session_id: Uuid;
  question_id: Uuid;
  giver_key: string;
  recipient_key: string;
  answer: Answer;
  giver_comment: string | null;
  updated_at: Timestamp;
  /** 'student', or the instructor's email when moderated */
  updated_by: string | null;
}

/** One entry of the `p_answers` array passed to student_submit. `answer` is untrusted JSON. */
export interface AnswerSubmission {
  recipient_key: string;
  answer: unknown;
  giver_comment?: string | null;
}

/** Output of resolveRecipients, same shape as SQL question_recipients(). */
export interface Recipient {
  recipient_key: string;
  display_name: string;
  /** Team key for student and team recipients; null for instructors and 'none'. */
  team_key: string | null;
}

// ---------------------------------------------------------------------------
// Keys (section 5)

export const NO_RECIPIENT_KEY = 'none';
export const NO_RECIPIENT_NAME = '(no recipient)';
export const ANONYMOUS_NAME = 'Anonymous';

export const studentKey = (studentId: Uuid): string => `s:${studentId}`;
export const instructorKey = (instructorId: Uuid): string => `i:${instructorId}`;
export const teamKey = (section: string, team: string): string => `t:${section}|${team}`;

export function isStudentKey(key: string): boolean {
  return key.startsWith('s:');
}
export function isInstructorKey(key: string): boolean {
  return key.startsWith('i:');
}
export function isTeamKey(key: string): boolean {
  return key.startsWith('t:');
}
/** Splits `t:<section>|<team>`. Returns null if the key is not a team key. Section and team never contain '|'. */
export function parseTeamKey(key: string): { section: string; team: string } | null {
  if (!isTeamKey(key)) return null;
  const rest = key.slice(2);
  const i = rest.indexOf('|');
  if (i < 0) return null;
  return { section: rest.slice(0, i), team: rest.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// Small guards

export function isQuestionType(v: unknown): v is QuestionType {
  return typeof v === 'string' && (QUESTION_TYPES as readonly string[]).includes(v);
}
export function isGiverType(v: unknown): v is GiverType {
  return typeof v === 'string' && (GIVER_TYPES as readonly string[]).includes(v);
}
export function isRecipientType(v: unknown): v is RecipientType {
  return typeof v === 'string' && (RECIPIENT_TYPES as readonly string[]).includes(v);
}
export function isVisibilityType(v: unknown): v is VisibilityType {
  return typeof v === 'string' && (VISIBILITY_TYPES as readonly string[]).includes(v);
}
