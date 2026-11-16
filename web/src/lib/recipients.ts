// Feedback paths and recipient resolution (ARCHITECTURE.md section 6).
// resolveRecipients() mirrors the SQL function question_recipients().

import {
  GiverType,
  NO_RECIPIENT_KEY,
  NO_RECIPIENT_NAME,
  QuestionType,
  Recipient,
  RecipientType,
  instructorKey,
  studentKey,
  teamKey,
} from './types';

// ---------------------------------------------------------------------------
// Allowed feedback paths

const STUDENT_GIVER_PATHS: readonly RecipientType[] = [
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
];

const INSTRUCTOR_GIVER_PATHS: readonly RecipientType[] = ['self', 'students', 'teams', 'instructors', 'none'];

/** Recipient types that make no sense for the "distribute among recipients" and "rank recipients" types. */
const NO_SELF_NO_TEAM_NO_NONE: readonly RecipientType[] = ['self', 'own_team', 'none'];

/** Allowed recipient types for a giver type, ignoring the question type. */
export function basePaths(giver: GiverType): readonly RecipientType[] {
  return giver === 'students' ? STUDENT_GIVER_PATHS : INSTRUCTOR_GIVER_PATHS;
}

/** Allowed recipient types for a giver type and question type (section 6 table and restrictions). */
export function allowedRecipientTypes(giver: GiverType, type: QuestionType): RecipientType[] {
  if (type === 'contrib') {
    return giver === 'students' ? ['own_team_members_including_self'] : [];
  }
  const base = basePaths(giver);
  if (type === 'constsum_recipients' || type === 'rank_recipients') {
    return base.filter((r) => !NO_SELF_NO_TEAM_NO_NONE.includes(r));
  }
  return [...base];
}

/** Giver types that can be used with a question type. */
export function allowedGiverTypes(type: QuestionType): GiverType[] {
  return type === 'contrib' ? ['students'] : ['students', 'instructors'];
}

export function isAllowedPath(giver: GiverType, recipient: RecipientType, type: QuestionType): boolean {
  return allowedRecipientTypes(giver, type).includes(recipient);
}

/** Human labels for the editor. */
export const RECIPIENT_TYPE_LABELS: Record<RecipientType, string> = {
  self: 'Giver (self feedback)',
  students: 'All students (including the giver)',
  students_excluding_self: 'All other students',
  teams: 'Teams',
  teams_excluding_self: 'Other teams',
  own_team: "Giver's own team",
  own_team_members: "Giver's team members",
  own_team_members_including_self: "Giver's team members, including the giver",
  instructors: 'Instructors',
  none: 'Nobody in particular (general feedback)',
};

export const GIVER_TYPE_LABELS: Record<GiverType, string> = {
  students: 'Students',
  instructors: 'Instructors',
};

// ---------------------------------------------------------------------------
// Resolution

/** Minimum student fields needed for resolution. A full `Student` row satisfies it. */
export interface RosterStudent {
  id: string;
  section: string;
  team: string;
  name: string;
}

/** Minimum instructor fields needed for resolution. A full `CourseInstructor` row satisfies it. */
export interface RosterInstructor {
  id: string;
  display_name: string;
  is_displayed_to_students: boolean;
  email?: string;
}

export type GiverRef =
  | { kind: 'student'; student: RosterStudent }
  | { kind: 'instructor'; instructor: RosterInstructor };

export const studentGiver = (student: RosterStudent): GiverRef => ({ kind: 'student', student });
export const instructorGiver = (instructor: RosterInstructor): GiverRef => ({ kind: 'instructor', instructor });

export function giverKey(giver: GiverRef): string {
  return giver.kind === 'student' ? studentKey(giver.student.id) : instructorKey(giver.instructor.id);
}

/** Plain code point comparison. Used for roster order so results do not depend on locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Roster order: section, team, name (then id for a stable tie-break). */
export function compareStudents(a: RosterStudent, b: RosterStudent): number {
  return cmp(a.section, b.section) || cmp(a.team, b.team) || cmp(a.name, b.name) || cmp(a.id, b.id);
}

export function sortRoster<T extends RosterStudent>(roster: readonly T[]): T[] {
  return [...roster].sort(compareStudents);
}

function studentRecipient(s: RosterStudent): Recipient {
  return { recipient_key: studentKey(s.id), display_name: s.name, team_key: teamKey(s.section, s.team) };
}

function teamRecipient(section: string, team: string): Recipient {
  const key = teamKey(section, team);
  return { recipient_key: key, display_name: team, team_key: key };
}

function instructorRecipient(i: RosterInstructor): Recipient {
  return { recipient_key: instructorKey(i.id), display_name: i.display_name, team_key: null };
}

/** Distinct teams in roster order. */
export function teamsOf(roster: readonly RosterStudent[]): { section: string; team: string }[] {
  const seen = new Set<string>();
  const out: { section: string; team: string }[] = [];
  for (const s of sortRoster(roster)) {
    const k = teamKey(s.section, s.team);
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ section: s.section, team: s.team });
    }
  }
  return out;
}

/** Instructors shown to students, ordered by display name then email then id. */
export function displayedInstructors(instructors: readonly RosterInstructor[]): RosterInstructor[] {
  return instructors
    .filter((i) => i.is_displayed_to_students)
    .sort((a, b) => cmp(a.display_name, b.display_name) || cmp(a.email ?? '', b.email ?? '') || cmp(a.id, b.id));
}

/**
 * Resolve the recipients one giver may answer for. Returns [] when the combination is not
 * available to that giver (for example `own_team` for an instructor giver).
 * Order: students by section, team, name; teams by section, team; instructors by display name.
 */
export function resolveRecipients(
  question: { giver_type: GiverType; recipient_type: RecipientType },
  giver: GiverRef,
  roster: readonly RosterStudent[],
  instructors: readonly RosterInstructor[],
): Recipient[] {
  const rt = question.recipient_type;
  if (rt === 'none') {
    return [{ recipient_key: NO_RECIPIENT_KEY, display_name: NO_RECIPIENT_NAME, team_key: null }];
  }

  if (giver.kind === 'instructor') {
    const inst = giver.instructor;
    switch (rt) {
      case 'self':
        return [instructorRecipient(inst)];
      case 'students':
        return sortRoster(roster).map(studentRecipient);
      case 'teams':
        return teamsOf(roster).map((t) => teamRecipient(t.section, t.team));
      case 'instructors':
        return displayedInstructors(instructors).map(instructorRecipient);
      default:
        return [];
    }
  }

  const me = giver.student;
  const myTeam = teamKey(me.section, me.team);
  const sorted = sortRoster(roster);
  switch (rt) {
    case 'self':
      return [studentRecipient(me)];
    case 'students':
      return sorted.map(studentRecipient);
    case 'students_excluding_self':
      return sorted.filter((s) => s.id !== me.id).map(studentRecipient);
    case 'teams':
      return teamsOf(roster).map((t) => teamRecipient(t.section, t.team));
    case 'teams_excluding_self':
      return teamsOf(roster)
        .filter((t) => teamKey(t.section, t.team) !== myTeam)
        .map((t) => teamRecipient(t.section, t.team));
    case 'own_team':
      return [teamRecipient(me.section, me.team)];
    case 'own_team_members':
      return sorted
        .filter((s) => teamKey(s.section, s.team) === myTeam && s.id !== me.id)
        .map(studentRecipient);
    case 'own_team_members_including_self':
      return sorted.filter((s) => teamKey(s.section, s.team) === myTeam).map(studentRecipient);
    case 'instructors':
      return displayedInstructors(instructors).map(instructorRecipient);
    default:
      return [];
  }
}

/**
 * How many recipients a giver may answer for: the resolved count, capped by max_recipients
 * (null = unlimited). Used by rank and distribute validation.
 */
export function recipientLimit(resolvedCount: number, maxRecipients: number | null): number {
  return maxRecipients == null ? resolvedCount : Math.min(maxRecipients, resolvedCount);
}
