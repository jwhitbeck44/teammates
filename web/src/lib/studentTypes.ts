// Types of the JSON returned by the student RPCs (BUILD_NOTES/01-database.md).
// Kept apart from api/student.ts so pure code and tests do not pull in the network client.

import type {
  DetailsByType,
  GiverType,
  QuestionType,
  Recipient,
  RecipientType,
  VisibilityType,
} from './types';
import type { SessionStatus } from './time';
import type { ResultRow, ContribClaim, ContribTeamView } from './studentView';


export interface CourseInfo {
  name: string;
  code: string;
  time_zone: string;
}

export interface PortalSession {
  id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  /** The real cutoff: close time plus grace, or the extension (whichever is later). Drives open/grace/closed. */
  deadline: string;
  /** The deadline to print: the extension, else the close time (no grace). Since migration 20261117000013. */
  shown_deadline?: string;
  status: Exclude<SessionStatus, 'not_open'>;
  published: boolean;
  /** At least one saved answer. */
  submitted: boolean;
  /** Questions this student can answer (they have recipients for the student). Since migration 20261117000013. */
  questions_answerable?: number;
  /** Of those, questions with at least one saved answer. */
  questions_answered?: number;
}

export interface StudentPortalData {
  course: CourseInfo;
  student: { name: string; team: string; section: string; email?: string };
  sessions: PortalSession[];
}

export interface PayloadAnswer {
  recipient_key: string;
  answer: unknown;
  giver_comment: string | null;
}

interface PayloadQuestionBase {
  id: string;
  number: number;
  brief: string;
  description: string;
  giver_type: GiverType;
  recipient_type: RecipientType;
  max_recipients: number | null;
  recipients: Recipient[];
  answers: PayloadAnswer[];
  /** Returned by student_get_session since migration 20261116000008; kept optional for older payloads. */
  show_responses_to?: VisibilityType[];
  show_giver_name_to?: VisibilityType[];
  show_recipient_name_to?: VisibilityType[];
}

/** One question of the session payload, discriminated by `type` so `details` is typed. */
export type PayloadQuestion = {
  [T in QuestionType]: PayloadQuestionBase & { type: T; details: DetailsByType[T] };
}[QuestionType];

export interface SessionInfo {
  id: string;
  name: string;
  instructions: string;
  opens_at: string;
  closes_at: string;
  grace_minutes: number;
  /** The real cutoff (see PortalSession.deadline). */
  deadline: string;
  /** The deadline to print (see PortalSession.shown_deadline). Absent in instructor_get_submission. */
  shown_deadline?: string;
  status: SessionStatus;
  published: boolean;
}

/**
 * Return type of student_get_session. The instructor payloads (instructor_preview has `student`,
 * instructor_get_submission has `instructor` instead) fit it too, hence the optional fields.
 */
export interface StudentSessionPayload {
  course: CourseInfo;
  student?: { name: string; team: string; section: string };
  instructor?: { id: string; display_name: string };
  session: SessionInfo;
  questions: PayloadQuestion[];
}

export interface AnswerToSave {
  recipient_key: string;
  answer: unknown;
  giver_comment?: string | null;
}

export interface ResultsQuestion {
  id: string;
  number: number;
  type: QuestionType;
  brief: string;
  description: string;
  details: unknown;
  responses: ResultRow[];
  contrib?: { my_claim: ContribClaim; team_view_of_me: ContribTeamView };
  /** Set instead of `contrib` while the session is still open for someone: the time the summary appears. */
  contrib_available_after?: string;
}

export interface StudentResultsData {
  course: CourseInfo;
  student: { name: string; team: string; section: string };
  session: { id: string; name: string };
  questions: ResultsQuestion[];
}

