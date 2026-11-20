// Turn response rows, the roster and the questions into the shapes the results pages, lib/stats and
// lib/csv need. Pure: no React, no network.
//
// Missing responses: for every giver of a question, the expected recipients (lib/recipients) minus the
// recipients the giver answered. When a question limits the number of recipients (max_recipients) the
// giver chooses whom to answer, so which ones are missing is unknown: a giver with no answers at all gets
// one missing row with a placeholder recipient, and a giver with some answers gets none.

import { resolveRecipients, instructorGiver, studentGiver, sortRoster } from './recipients';
import type { RosterInstructor, RosterStudent } from './recipients';
import type { ContribTeam, StatRecipient, StatResponse } from './stats';
import type { ResultsParty, ResultsQuestion, ResultsResponse } from './csv';
import {
  GiverType,
  NO_RECIPIENT_KEY,
  NO_RECIPIENT_NAME,
  QuestionType,
  RecipientType,
  ROLE_PERMISSIONS,
  InstructorRole,
  instructorKey,
  parseTeamKey,
  studentKey,
  teamKey,
} from './types';

// ---------------------------------------------------------------------------
// Input shapes (database rows satisfy these)

export interface ResultsStudent extends RosterStudent {
  email: string;
}

export interface ResultsInstructor extends RosterInstructor {
  email: string;
  role?: InstructorRole;
}

export interface ResultsQuestionInput {
  id: string;
  number: number;
  type: QuestionType;
  brief: string;
  details: unknown;
  giver_type: GiverType;
  recipient_type: RecipientType;
  max_recipients: number | null;
}

export interface ResultsResponseInput {
  question_id: string;
  giver_key: string;
  recipient_key: string;
  answer: unknown;
  giver_comment: string | null;
  updated_at?: string;
  /** Row id; breaks ties between rows with the same updated_at (contribTeamsFromRows). */
  id?: string;
  /** Giver's team key and team members when the row was written (migration 11). Absent in older reads. */
  giver_team_key?: string | null;
  giver_team_ids?: string[] | null;
}

export const REMOVED_NAME = '(removed)';
export const ANY_RECIPIENT_NAME = '(any recipient)';
export const ANY_RECIPIENT_KEY = '?';

// ---------------------------------------------------------------------------
// People index

export interface PartyIndex {
  party(key: string): ResultsParty;
  /** Section of a student or team key; null for instructors, 'none' and unknown keys. */
  section(key: string): string | null;
}

export function buildPartyIndex(students: readonly ResultsStudent[], instructors: readonly ResultsInstructor[]): PartyIndex {
  const parties = new Map<string, ResultsParty>();
  const sections = new Map<string, string>();
  for (const s of students) {
    const key = studentKey(s.id);
    const tk = teamKey(s.section, s.team);
    parties.set(key, { key, name: s.name, email: s.email, team: s.team, kind: 'student', team_key: tk });
    sections.set(key, s.section);
    if (!parties.has(tk)) {
      parties.set(tk, { key: tk, name: s.team, email: '', team: s.team, kind: 'team', team_key: tk });
      sections.set(tk, s.section);
    }
  }
  for (const i of instructors) {
    const key = instructorKey(i.id);
    parties.set(key, { key, name: i.display_name, email: i.email, team: '', kind: 'instructor', team_key: null });
  }
  parties.set(NO_RECIPIENT_KEY, { key: NO_RECIPIENT_KEY, name: NO_RECIPIENT_NAME, email: '', team: '', kind: 'none', team_key: null });
  return {
    party(key) {
      const known = parties.get(key);
      if (known) return known;
      const t = parseTeamKey(key);
      if (t) return { key, name: t.team, email: '', team: t.team, kind: 'team', team_key: key };
      return { key, name: REMOVED_NAME, email: '', team: '', kind: key.startsWith('s:') ? 'student' : 'instructor', team_key: null };
    },
    section(key) {
      return sections.get(key) ?? parseTeamKey(key)?.section ?? null;
    },
  };
}

export function toStatRecipient(p: ResultsParty): StatRecipient {
  return { key: p.key, name: p.name, email: p.email === '' ? null : p.email, team: p.team, team_key: p.team_key ?? null, kind: p.kind ?? 'student' };
}

// ---------------------------------------------------------------------------
// (a) Shapes for stats and CSV

/** Response rows of one question as ResultsResponse (answers present). */
export function toResultsResponses(rows: readonly ResultsResponseInput[], index: PartyIndex): ResultsResponse[] {
  return rows.map((r) => ({
    giver: index.party(r.giver_key),
    recipient: index.party(r.recipient_key),
    answer: r.answer,
    giver_comment: r.giver_comment,
  }));
}

export function toStatResponses(rows: readonly ResultsResponse[]): StatResponse[] {
  return rows
    .filter((r) => r.answer !== null && r.answer !== undefined)
    .map((r) => ({ giver_key: r.giver.key, recipient: toStatRecipient(r.recipient), answer: r.answer }));
}

/**
 * Teams of one contrib question, from the teams stored on its response rows, so the results of a closed
 * session do not change when teams change later. Mirror of SQL contrib_team_members() (migration
 * 20261117000013); same rules, in order:
 *   1. a student who gave answers on the question: the team stamped on those rows (the latest row wins);
 *   2. else a student listed in giver_team_ids of another giver's rows: that row's team (the latest row wins);
 *   3. else the student's current team, but only when no stored row carries that team key.
 * Deleted students (not in `students`) are left out. Teams are in roster order of their first member; the
 * statistics sort them again. Rows without stored teams (older reads) behave as the current roster.
 */
export function contribTeamsFromRows(questionId: string, rows: readonly ResultsResponseInput[], students: readonly ResultsStudent[]): ContribTeam[] {
  const given = rows.filter((r) => r.question_id === questionId && r.giver_key.startsWith('s:') && r.giver_team_key);
  // latest first: updated_at descending, then id descending (as the SQL "order by updated_at desc, id desc")
  const later = (a: ResultsResponseInput, b: ResultsResponseInput) => {
    const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
    const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
    if (ta !== tb) return tb - ta;
    const ia = a.id ?? '';
    const ib = b.id ?? '';
    return ia < ib ? 1 : ia > ib ? -1 : 0;
  };
  const sorted = [...given].sort(later);
  const own = new Map<string, string>();
  const named = new Map<string, string>();
  const stored = new Set<string>();
  for (const r of sorted) {
    const k = r.giver_team_key as string;
    stored.add(k);
    const gid = r.giver_key.slice(2);
    if (!own.has(gid)) own.set(gid, k);
    for (const id of r.giver_team_ids ?? []) if (!named.has(id)) named.set(id, k);
  }
  const out = new Map<string, ContribTeam>();
  for (const s of sortRoster(students)) {
    const current = teamKey(s.section, s.team);
    const k = own.get(s.id) ?? named.get(s.id) ?? (stored.has(current) ? null : current);
    if (k === null) continue;
    if (!out.has(k)) out.set(k, { team_key: k, team: parseTeamKey(k)?.team ?? s.team, members: [] });
    out.get(k)!.members.push({ key: studentKey(s.id), name: s.name, email: s.email });
  }
  return [...out.values()];
}

/** Every student grouped by current team (no stored teams). Kept for callers without response rows. */
export function contribTeamsOf(students: readonly ResultsStudent[]): ContribTeam[] {
  const out = new Map<string, ContribTeam>();
  for (const s of sortRoster(students)) {
    const key = teamKey(s.section, s.team);
    if (!out.has(key)) out.set(key, { team_key: key, team: s.team, members: [] });
    out.get(key)!.members.push({ key: studentKey(s.id), name: s.name, email: s.email });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// (b) Missing responses

export interface MissingResponse {
  question_id: string;
  giver_key: string;
  recipient_key: string;
  recipient_name: string;
}

function canSubmit(i: ResultsInstructor): boolean {
  return i.role === undefined || ROLE_PERMISSIONS[i.role].submit;
}

/** Givers of a question: all students, or the instructors who may submit. */
function giversOf(
  question: Pick<ResultsQuestionInput, 'giver_type'>,
  students: readonly ResultsStudent[],
  instructors: readonly ResultsInstructor[],
) {
  return question.giver_type === 'students'
    ? sortRoster(students).map((s) => ({ key: studentKey(s.id), ref: studentGiver(s) }))
    : instructors.filter(canSubmit).map((i) => ({ key: instructorKey(i.id), ref: instructorGiver(i) }));
}

/** Expected recipients minus answered ones, per giver, for one question. */
export function missingForQuestion(
  question: ResultsQuestionInput,
  rows: readonly ResultsResponseInput[],
  students: readonly ResultsStudent[],
  instructors: readonly ResultsInstructor[],
): MissingResponse[] {
  const answered = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.question_id !== question.id) continue;
    if (!answered.has(r.giver_key)) answered.set(r.giver_key, new Set());
    answered.get(r.giver_key)!.add(r.recipient_key);
  }
  const out: MissingResponse[] = [];
  for (const g of giversOf(question, students, instructors)) {
    const done = answered.get(g.key) ?? new Set<string>();
    const expected = resolveRecipients(question, g.ref, students, instructors);
    if (expected.length === 0) continue;
    if (question.max_recipients !== null) {
      if (done.size === 0) {
        out.push({ question_id: question.id, giver_key: g.key, recipient_key: ANY_RECIPIENT_KEY, recipient_name: ANY_RECIPIENT_NAME });
      }
      continue;
    }
    for (const r of expected) {
      if (!done.has(r.recipient_key)) {
        out.push({ question_id: question.id, giver_key: g.key, recipient_key: r.recipient_key, recipient_name: r.display_name });
      }
    }
  }
  return out;
}

export function missingResponses(
  questions: readonly ResultsQuestionInput[],
  rows: readonly ResultsResponseInput[],
  students: readonly ResultsStudent[],
  instructors: readonly ResultsInstructor[],
): MissingResponse[] {
  return questions.flatMap((q) => missingForQuestion(q, rows, students, instructors));
}

// ---------------------------------------------------------------------------
// Section filter

export type SectionMode = 'either' | 'giver' | 'recipient' | 'both';

export const SECTION_MODE_LABELS: Record<SectionMode, string> = {
  either: 'Giver or recipient in the section',
  giver: 'Giver in the section',
  recipient: 'Recipient in the section',
  both: 'Giver and recipient in the section',
};

/** True when the response passes the section filter. Instructors and 'none' have no section and never match a section. */
export function inSection(giverKey: string, recipientKey: string, section: string | null, mode: SectionMode, index: PartyIndex): boolean {
  if (section === null) return true;
  const g = index.section(giverKey) === section;
  const r = index.section(recipientKey) === section;
  switch (mode) {
    case 'giver':
      return g;
    case 'recipient':
      return r;
    case 'both':
      return g && r;
    default:
      return g || r;
  }
}

// ---------------------------------------------------------------------------
// Results questions for stats and CSV

export interface BuildOptions {
  includeMissing: boolean;
  section?: string | null;
  sectionMode?: SectionMode;
  /** Questions to include (default all). */
  questionIds?: readonly string[];
}

export function buildResultsQuestions(
  questions: readonly ResultsQuestionInput[],
  rows: readonly ResultsResponseInput[],
  students: readonly ResultsStudent[],
  instructors: readonly ResultsInstructor[],
  opts: BuildOptions,
): ResultsQuestion[] {
  const index = buildPartyIndex(students, instructors);
  const section = opts.section ?? null;
  const mode = opts.sectionMode ?? 'either';
  const keep = (g: string, r: string) => inSection(g, r, section, mode, index);
  const out: ResultsQuestion[] = [];
  for (const q of [...questions].sort((a, b) => a.number - b.number)) {
    if (opts.questionIds && !opts.questionIds.includes(q.id)) continue;
    const own = rows.filter((r) => r.question_id === q.id && keep(r.giver_key, r.recipient_key));
    const responses = toResultsResponses(own, index);
    if (opts.includeMissing) {
      for (const m of missingForQuestion(q, rows, students, instructors)) {
        if (!keep(m.giver_key, m.recipient_key === ANY_RECIPIENT_KEY ? m.giver_key : m.recipient_key)) continue;
        const recipient: ResultsParty =
          m.recipient_key === ANY_RECIPIENT_KEY
            ? { key: ANY_RECIPIENT_KEY, name: ANY_RECIPIENT_NAME, email: '', team: '', kind: 'none', team_key: null }
            : index.party(m.recipient_key);
        responses.push({ giver: index.party(m.giver_key), recipient, answer: null, giver_comment: null });
      }
    }
    const item: ResultsQuestion = { number: q.number, brief: q.brief, type: q.type, details: q.details, responses };
    if (q.type === 'contrib') {
      item.contribMembers = sortRoster(students).map((s) => index.party(studentKey(s.id)));
      // teams from the stored rows (all rows of the question, before the section filter), as the SQL does
      item.contribTeams = contribTeamsFromRows(q.id, rows, students);
    }
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grouping for the by-giver and by-recipient views

export interface Group<T> {
  key: string;
  name: string;
  team: string;
  email: string;
  items: T[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Group by giver or recipient; groups ordered by team then name. */
export function groupBy<T extends { giver: ResultsParty; recipient: ResultsParty }>(items: readonly T[], by: 'giver' | 'recipient'): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  for (const it of items) {
    const p = it[by];
    if (!groups.has(p.key)) groups.set(p.key, { key: p.key, name: p.name, team: p.team, email: p.email, items: [] });
    groups.get(p.key)!.items.push(it);
  }
  return [...groups.values()].sort((a, b) => cmp(a.team, b.team) || cmp(a.name, b.name) || cmp(a.key, b.key));
}

// ---------------------------------------------------------------------------
// (c) Submission status and non-submitters

export interface StudentSubmission {
  student_id: string;
  submitted: boolean;
  /** Number of response rows given by the student. */
  count: number;
  /** Latest updated_at over the student's rows, or null. */
  last_updated: string | null;
}

/**
 * Per student: has the student given at least one response (to a student-giver question)?
 * `rows` are all response rows of the session.
 */
export function submissionStatus(
  students: readonly { id: string }[],
  rows: readonly Pick<ResultsResponseInput, 'giver_key' | 'updated_at'>[],
): Map<string, StudentSubmission> {
  const byKey = new Map<string, { count: number; last: string | null }>();
  for (const r of rows) {
    if (!r.giver_key.startsWith('s:')) continue;
    const cur = byKey.get(r.giver_key) ?? { count: 0, last: null };
    cur.count += 1;
    if (r.updated_at && (cur.last === null || Date.parse(r.updated_at) > Date.parse(cur.last))) cur.last = r.updated_at;
    byKey.set(r.giver_key, cur);
  }
  const out = new Map<string, StudentSubmission>();
  for (const s of students) {
    const e = byKey.get(studentKey(s.id));
    out.set(s.id, { student_id: s.id, submitted: !!e && e.count > 0, count: e?.count ?? 0, last_updated: e?.last ?? null });
  }
  return out;
}

/** Questions answered out of questions the student can answer. */
export interface QuestionProgress {
  student_id: string;
  /** Student-giver questions with at least one recipient for this student. */
  answerable: number;
  /** Of those, questions with at least one saved row by the student. */
  answered: number;
  /** Ids of answerable questions without a saved row. */
  unanswered: string[];
}

/**
 * Per student: questions answered out of questions they can answer. A question with no recipients for the
 * student (a team of one on a teammates question, no instructor shown to students) does not count. Mirror of
 * SQL student_question_counts() (the student portal) and of submittedAll in supabase/functions/_shared/due.ts.
 */
export function questionProgress(
  questions: readonly Pick<ResultsQuestionInput, 'id' | 'giver_type' | 'recipient_type'>[],
  students: readonly RosterStudent[],
  instructors: readonly RosterInstructor[],
  rows: readonly Pick<ResultsResponseInput, 'question_id' | 'giver_key'>[],
): Map<string, QuestionProgress> {
  const answered = new Set(rows.map((r) => `${r.question_id}|${r.giver_key}`));
  const studentQs = questions.filter((q) => q.giver_type === 'students');
  const out = new Map<string, QuestionProgress>();
  for (const s of students) {
    const p: QuestionProgress = { student_id: s.id, answerable: 0, answered: 0, unanswered: [] };
    for (const q of studentQs) {
      if (resolveRecipients(q, studentGiver(s), students, instructors).length === 0) continue;
      p.answerable++;
      if (answered.has(`${q.id}|${studentKey(s.id)}`)) p.answered++;
      else p.unanswered.push(q.id);
    }
    out.set(s.id, p);
  }
  return out;
}

/** Students with at least one answerable question left unanswered, in roster order. */
export function studentsWithUnanswered<T extends RosterStudent>(students: readonly T[], progress: Map<string, QuestionProgress>): T[] {
  return sortRoster(students).filter((s) => (progress.get(s.id)?.unanswered.length ?? 0) > 0);
}

/** Students without any response, in roster order. */
export function nonSubmitters<T extends RosterStudent>(
  students: readonly T[],
  rows: readonly Pick<ResultsResponseInput, 'giver_key' | 'updated_at'>[],
): T[] {
  const status = submissionStatus(students, rows);
  return sortRoster(students).filter((s) => !status.get(s.id)?.submitted);
}
