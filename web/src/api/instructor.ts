// Thin wrappers over supabase-js for the instructor pages. Every call throws ApiError on failure;
// the database (RLS and RPCs) decides what is allowed. See BUILD_NOTES/05-instructor-ui.md for the
// list of operations per page.

import { publicApiKey, supabase } from './client';
import { errorMessage, isErrorCode } from '../lib/errors';
import type { StudentSessionPayload } from '../lib/studentTypes';
import type {
  Course,
  CourseInstructor,
  DeadlineExtension,
  EmailLog,
  InstructorRole,
  Question,
  QuestionDraft,
  ResponseRow,
  ResultsVisibility,
  Session,
  Student,
  StudentLink,
  Uuid,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Errors

/**
 * `code` is what the database raised (an error code such as `sum_mismatch`, or raw Postgres text).
 * `message` is the plain text for known codes, so shared components such as SubmissionForm can show it.
 * `recipient_key` is set when the database named the offending recipient in the error details.
 */
export class ApiError extends Error {
  code: string;
  details: string;
  pgCode: string;
  recipient_key: string | null;
  constructor(code: string, details = '', pgCode = '') {
    super(isErrorCode(code) ? errorMessage(code) : code);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.pgCode = pgCode;
    this.recipient_key = /^(s:|i:|t:|none$)/.test(details) ? details : null;
  }
}

interface PgErr {
  message: string;
  details?: string | null;
  code?: string | null;
}

function fail(error: PgErr): never {
  throw new ApiError(error.message, error.details ?? '', error.code ?? '');
}

async function run<T>(p: PromiseLike<{ data: T | null; error: PgErr | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) fail(error);
  return data as T;
}

async function runVoid(p: PromiseLike<{ error: PgErr | null }>): Promise<void> {
  const { error } = await p;
  if (error) fail(error);
}

/** Plain message for any thrown value. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (isErrorCode(e.code)) return errorMessage(e.code);
    if (e.pgCode === '42501') return errorMessage('forbidden');
    if (e.pgCode === '23505') return 'That name or email is already used here.';
    if (e.pgCode === '23503') return 'That item no longer exists. Reload the page.';
    return `Something went wrong: ${e.message}`;
  }
  if (e instanceof Error) return `Something went wrong: ${e.message}`;
  return 'Something went wrong. Please try again.';
}

/** True when an insert was refused by row-level security (for example a user not on the allowlist). */
export function isRlsDenied(e: unknown): boolean {
  return e instanceof ApiError && (e.pgCode === '42501' || /row-level security/i.test(e.message));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

/** Page through a query in blocks of 1000 rows (the PostgREST default limit). */
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PgErr | null }>,
): Promise<T[]> {
  const size = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const rows = await run(build(from, from + size - 1));
    out.push(...rows);
    if (rows.length < size) return out;
  }
}

// ---------------------------------------------------------------------------
// Courses

export interface CourseWithRole extends Course {
  role: InstructorRole | null;
}

export async function listMyCourses(userId: Uuid): Promise<CourseWithRole[]> {
  const courses = await run<Course[]>(supabase.from('courses').select('*').order('code'));
  const mine = await run<{ course_id: Uuid; role: InstructorRole }[]>(
    supabase.from('course_instructors').select('course_id, role').eq('user_id', userId),
  );
  const roles = new Map(mine.map((m) => [m.course_id, m.role]));
  return courses.map((c) => ({ ...c, role: roles.get(c.id) ?? null }));
}

export interface CourseInput {
  code: string;
  name: string;
  institute: string | null;
  time_zone: string;
}

export function createCourse(input: CourseInput): Promise<Course> {
  return run<Course>(supabase.from('courses').insert(input).select().single());
}

export function getCourse(courseId: Uuid): Promise<Course> {
  return run<Course>(supabase.from('courses').select('*').eq('id', courseId).single());
}

export async function updateCourse(courseId: Uuid, patch: Partial<CourseInput> & { archived_at?: string | null }): Promise<void> {
  const rows = await run<Course[]>(supabase.from('courses').update(patch).eq('id', courseId).select());
  if (rows.length === 0) throw new ApiError('forbidden');
}

export async function deleteCourse(courseId: Uuid): Promise<void> {
  const rows = await run<Course[]>(supabase.from('courses').delete().eq('id', courseId).select());
  if (rows.length === 0) throw new ApiError('forbidden');
}

/** The signed-in user's role in a course, from course_instructors (null when not an instructor there). */
export async function getMyRole(courseId: Uuid, userId: Uuid): Promise<InstructorRole | null> {
  const row = await run<{ role: InstructorRole }[]>(
    supabase.from('course_instructors').select('role').eq('course_id', courseId).eq('user_id', userId),
  );
  return row[0]?.role ?? null;
}

// ---------------------------------------------------------------------------
// Instructors

export function listInstructors(courseId: Uuid): Promise<CourseInstructor[]> {
  return run<CourseInstructor[]>(supabase.from('course_instructors').select('*').eq('course_id', courseId).order('display_name'));
}

export interface InstructorInput {
  email: string;
  display_name: string;
  role: InstructorRole;
  is_displayed_to_students: boolean;
}

export async function inviteInstructor(courseId: Uuid, input: InstructorInput): Promise<void> {
  await runVoid(supabase.from('course_instructors').insert({ course_id: courseId, ...input }));
}

export async function updateInstructor(
  id: Uuid,
  patch: Partial<Pick<InstructorInput, 'display_name' | 'role' | 'is_displayed_to_students'>>,
): Promise<void> {
  const rows = await run<CourseInstructor[]>(supabase.from('course_instructors').update(patch).eq('id', id).select());
  if (rows.length === 0) throw new ApiError('forbidden');
}

export async function removeInstructor(id: Uuid): Promise<void> {
  const rows = await run<CourseInstructor[]>(supabase.from('course_instructors').delete().eq('id', id).select());
  if (rows.length === 0) throw new ApiError('forbidden');
}

// ---------------------------------------------------------------------------
// Students

// access_token is not readable by clients (column grant); the links come from instructor_student_links.
const STUDENT_COLUMNS = 'id, course_id, section, team, name, email, comments, created_at';

export function listStudents(courseId: Uuid): Promise<Student[]> {
  return fetchAll<Student>((a, b) =>
    supabase.from('students').select(STUDENT_COLUMNS).eq('course_id', courseId).order('section').order('team').order('name').range(a, b),
  );
}

export interface StudentInputRow {
  section: string;
  team: string;
  name: string;
  email: string;
  comments: string | null;
}

export async function updateStudent(id: Uuid, patch: StudentInputRow): Promise<void> {
  const rows = await run<Student[]>(supabase.from('students').update(patch).eq('id', id).select('id'));
  if (rows.length === 0) throw new ApiError('forbidden');
}

/** True when the student has given or received any response (or when this cannot be checked). */
export async function studentHasResponses(id: Uuid): Promise<boolean> {
  const { count, error } = await supabase
    .from('responses')
    .select('id', { count: 'exact', head: true })
    .or(`giver_key.eq.s:${id},recipient_key.eq.s:${id}`);
  return error ? true : (count ?? 0) > 0;
}

export async function deleteStudent(id: Uuid): Promise<void> {
  const rows = await run<{ id: Uuid }[]>(supabase.from('students').delete().eq('id', id).select('id'));
  if (rows.length === 0) throw new ApiError('forbidden');
}

/** Every student's private link token. Needs modify_students; other roles get `forbidden`. */
export function listStudentLinks(courseId: Uuid): Promise<StudentLink[]> {
  return run<StudentLink[]>(supabase.rpc('instructor_student_links', { p_course: courseId }));
}

export async function regenerateStudentToken(studentId: Uuid): Promise<string> {
  const r = await run<{ access_token: string }>(supabase.rpc('regenerate_student_token', { p_student: studentId }));
  return r.access_token;
}

export interface EnrollResult {
  created: number;
  updated: number;
  errors: { row: number; code: string }[];
}

export function enrollStudents(courseId: Uuid, rows: StudentInputRow[]): Promise<EnrollResult> {
  return run<EnrollResult>(supabase.rpc('enroll_students', { p_course: courseId, p_rows: rows }));
}

// ---------------------------------------------------------------------------
// Sessions

export function listSessions(courseId: Uuid): Promise<Session[]> {
  return run<Session[]>(supabase.from('sessions').select('*').eq('course_id', courseId).order('opens_at', { ascending: false }));
}

export function getSession(sessionId: Uuid): Promise<Session> {
  return run<Session>(supabase.from('sessions').select('*').eq('id', sessionId).single());
}

export interface SessionInput {
  name: string;
  instructions: string;
  opens_at: string;
  closes_at: string;
  grace_minutes: number;
  results_visibility: ResultsVisibility;
  results_visible_at: string | null;
  closing_email_enabled: boolean;
  published_email_enabled: boolean;
}

/** Creates a session and its questions. Questions are numbered 1..n in the given order. */
export async function createSession(courseId: Uuid, input: SessionInput, questions: QuestionDraft[]): Promise<Session> {
  const session = await run<Session>(supabase.from('sessions').insert({ course_id: courseId, ...input }).select().single());
  if (questions.length > 0) {
    const rows = questions.map((q, i) => questionRow(session.id, q, i + 1));
    const { error } = await supabase.from('questions').insert(rows);
    if (error) {
      await supabase.from('sessions').delete().eq('id', session.id);
      fail(error);
    }
  }
  return session;
}

export async function updateSession(sessionId: Uuid, input: SessionInput): Promise<void> {
  const rows = await run<{ id: Uuid }[]>(supabase.from('sessions').update(input).eq('id', sessionId).select('id'));
  if (rows.length === 0) throw new ApiError('forbidden');
}

export async function deleteSession(sessionId: Uuid): Promise<void> {
  const rows = await run<{ id: Uuid }[]>(supabase.from('sessions').delete().eq('id', sessionId).select('id'));
  if (rows.length === 0) throw new ApiError('forbidden');
}

export async function copySession(sessionId: Uuid, newName: string, targetCourse: Uuid | null): Promise<Uuid> {
  const r = await run<{ session_id: Uuid }>(
    supabase.rpc('copy_session', { p_session: sessionId, p_new_name: newName, p_target_course: targetCourse }),
  );
  return r.session_id;
}

export async function publishSession(sessionId: Uuid): Promise<void> {
  await run(supabase.rpc('publish_session', { p_session: sessionId }));
}

export async function unpublishSession(sessionId: Uuid): Promise<void> {
  await run(supabase.rpc('unpublish_session', { p_session: sessionId }));
}

/** Student giver keys per session that have at least one response (for submission counts). */
export async function listSubmitters(sessionIds: Uuid[]): Promise<Map<Uuid, Set<string>>> {
  const out = new Map<Uuid, Set<string>>();
  if (sessionIds.length === 0) return out;
  const rows = await fetchAll<{ session_id: Uuid; giver_key: string }>((a, b) =>
    supabase
      .from('responses')
      .select('session_id, giver_key')
      .in('session_id', sessionIds)
      .like('giver_key', 's:%')
      .order('id')
      .range(a, b),
  );
  for (const r of rows) {
    if (!out.has(r.session_id)) out.set(r.session_id, new Set());
    out.get(r.session_id)!.add(r.giver_key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Questions

export type StoredQuestion = Question;

export function listQuestions(sessionId: Uuid): Promise<Question[]> {
  return run<Question[]>(supabase.from('questions').select('*').eq('session_id', sessionId).order('number'));
}

function questionRow(sessionId: Uuid, q: QuestionDraft, number: number): Json {
  return {
    session_id: sessionId,
    number,
    type: q.type,
    brief: q.brief,
    description: q.description,
    details: q.details,
    giver_type: q.giver_type,
    recipient_type: q.recipient_type,
    max_recipients: q.max_recipients,
    show_responses_to: q.show_responses_to,
    show_giver_name_to: q.show_giver_name_to,
    show_recipient_name_to: q.show_recipient_name_to,
  };
}

export function addQuestion(sessionId: Uuid, q: QuestionDraft): Promise<Question> {
  return run<Question>(supabase.from('questions').insert(questionRow(sessionId, q, q.number)).select().single());
}

export async function updateQuestion(id: Uuid, q: QuestionDraft): Promise<void> {
  const { session_id: _s, ...row } = questionRow('', q, q.number);
  void _s;
  const rows = await run<{ id: Uuid }[]>(supabase.from('questions').update(row).eq('id', id).select('id'));
  if (rows.length === 0) throw new ApiError('forbidden');
}

export async function deleteQuestion(id: Uuid): Promise<void> {
  const rows = await run<{ id: Uuid }[]>(supabase.from('questions').delete().eq('id', id).select('id'));
  if (rows.length === 0) throw new ApiError('forbidden');
}

/**
 * Renumber questions to 1..n in the given id order. Each update is its own request, so the
 * unique (session_id, number) constraint is checked after each one: move changed questions to
 * temporary numbers first, then to their final numbers.
 */
export async function renumberQuestions(orderedIds: Uuid[], current: Map<Uuid, number>): Promise<void> {
  const changed = orderedIds.map((id, i) => ({ id, number: i + 1 })).filter((x) => current.get(x.id) !== x.number);
  if (changed.length === 0) return;
  const base = 10000;
  for (const [i, c] of changed.entries()) {
    await runVoid(supabase.from('questions').update({ number: base + i }).eq('id', c.id));
  }
  for (const c of changed) {
    await runVoid(supabase.from('questions').update({ number: c.number }).eq('id', c.id));
  }
}

export async function countResponsesByQuestion(sessionId: Uuid): Promise<Map<Uuid, number>> {
  const rows = await fetchAll<{ question_id: Uuid }>((a, b) =>
    supabase.from('responses').select('question_id').eq('session_id', sessionId).order('id').range(a, b),
  );
  const out = new Map<Uuid, number>();
  for (const r of rows) out.set(r.question_id, (out.get(r.question_id) ?? 0) + 1);
  return out;
}

// ---------------------------------------------------------------------------
// Responses and results

export function listResponses(sessionId: Uuid): Promise<ResponseRow[]> {
  return fetchAll<ResponseRow>((a, b) =>
    supabase
      .from('responses')
      .select('id, session_id, question_id, giver_key, recipient_key, answer, giver_comment, updated_at, updated_by, giver_team_key, giver_team_ids')
      .eq('session_id', sessionId)
      .order('id')
      .range(a, b),
  );
}

/** Question, giver key and update time of every response row (for submission status; no answer text). */
export function listResponseMeta(sessionId: Uuid): Promise<{ question_id: Uuid; giver_key: string; updated_at: string }[]> {
  return fetchAll((a, b) =>
    supabase.from('responses').select('question_id, giver_key, updated_at').eq('session_id', sessionId).order('id').range(a, b),
  );
}

/** Every email_log row of a session, newest first. RLS (email_log_select) allows this with modify_sessions. */
export function listEmailLog(sessionId: Uuid): Promise<EmailLog[]> {
  return fetchAll<EmailLog>((a, b) =>
    supabase
      .from('email_log')
      .select('id, session_id, kind, to_email, student_id, status, error, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .order('id')
      .range(a, b),
  );
}

export interface ContribResultStudent {
  student_id: Uuid;
  section: string;
  team: string;
  team_key: string;
  name: string;
  email: string;
  claimed: number;
  perceived: number;
  diff: number;
  ratings_received: number[];
}

export async function contribResults(questionId: Uuid): Promise<ContribResultStudent[]> {
  const r = await run<{ students: ContribResultStudent[] }>(supabase.rpc('instructor_contrib_results', { p_question: questionId }));
  return r.students;
}

// ---------------------------------------------------------------------------
// Deadline extensions

export function listExtensions(sessionId: Uuid): Promise<DeadlineExtension[]> {
  return run<DeadlineExtension[]>(supabase.from('deadline_extensions').select('*').eq('session_id', sessionId));
}

export async function saveExtension(sessionId: Uuid, studentId: Uuid, closesAt: string): Promise<void> {
  await runVoid(
    supabase.from('deadline_extensions').upsert(
      { session_id: sessionId, student_id: studentId, closes_at: closesAt },
      { onConflict: 'session_id,student_id' },
    ),
  );
}

export async function removeExtension(sessionId: Uuid, studentId: Uuid): Promise<void> {
  await runVoid(supabase.from('deadline_extensions').delete().eq('session_id', sessionId).eq('student_id', studentId));
}

// ---------------------------------------------------------------------------
// Submission payloads (student_get_session shape) and saves

export function getInstructorSubmission(sessionId: Uuid): Promise<StudentSessionPayload> {
  return run<StudentSessionPayload>(supabase.rpc('instructor_get_submission', { p_session: sessionId }));
}

export function getPreview(sessionId: Uuid, studentId: Uuid): Promise<StudentSessionPayload> {
  return run<StudentSessionPayload>(supabase.rpc('instructor_preview', { p_session: sessionId, p_student: studentId }));
}

export interface AnswerRows {
  recipient_key: string;
  answer: unknown;
  giver_comment?: string | null;
}

export async function instructorSubmit(sessionId: Uuid, questionId: Uuid, answers: AnswerRows[]): Promise<void> {
  await run(supabase.rpc('instructor_submit', { p_session: sessionId, p_question: questionId, p_answers: answers }));
}

export async function instructorModerate(sessionId: Uuid, questionId: Uuid, studentId: Uuid, answers: AnswerRows[]): Promise<void> {
  await run(
    supabase.rpc('instructor_moderate', { p_session: sessionId, p_question: questionId, p_student: studentId, p_answers: answers }),
  );
}

// ---------------------------------------------------------------------------
// Reminder emails (Edge Function send-reminder, BUILD_NOTES/03)

export interface ReminderResult {
  ok: boolean;
  sent: number;
  failed: number;
  skipped: number;
  ignored: number;
  remaining: number;
}

const REMINDER_ERRORS: Record<string, string> = {
  unauthorized: 'Your sign-in has expired. Sign in again.',
  forbidden: 'You do not have permission to send reminders for this session.',
  not_open_yet: 'The session is not open yet.',
  not_published: 'Results are not published yet.',
  too_many_students: 'Too many students in one request.',
  internal_error: 'The email service failed. Try again in a few minutes.',
};

/** Sends reminders in blocks of 200 students (the function's limit) and adds the results together. */
export async function sendReminder(
  sessionId: Uuid,
  studentIds: Uuid[],
  kind: 'submit' | 'results',
  copyToMe: boolean,
): Promise<ReminderResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('unauthorized');
  const total: ReminderResult = { ok: true, sent: 0, failed: 0, skipped: 0, ignored: 0, remaining: 0 };
  for (let i = 0; i < studentIds.length; i += 200) {
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-reminder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: publicApiKey,
      },
      body: JSON.stringify({ session_id: sessionId, student_ids: studentIds.slice(i, i + 200), kind, copy_to_me: copyToMe && i === 0 }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<ReminderResult> & { error?: string };
    if (!res.ok || body.ok === false) {
      const code = body.error ?? 'internal_error';
      throw new Error(REMINDER_ERRORS[code] ?? `The reminder could not be sent (${code}).`);
    }
    total.sent += body.sent ?? 0;
    total.failed += body.failed ?? 0;
    total.skipped += body.skipped ?? 0;
    total.ignored += body.ignored ?? 0;
    total.remaining += body.remaining ?? 0;
  }
  return total;
}
