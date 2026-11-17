// CSV in and out (spec sections j and k): generic reader and writer, roster parsing with per-row
// errors, the results CSV in the TEAMMATES layout, the student links CSV, the non-submitter CSV.

import { alphabeticalIndex, answerText, contribValueText, NO_RESPONSE_TEXT, numberText } from './answerText';
import { contribPointToText } from './contrib';
import { ErrorCode, makeError } from './errors';
import {
  ContribTeam,
  QuestionStats,
  StatRecipient,
  StatResponse,
  questionStats,
} from './stats';
import {
  ConstsumOptionsDetails,
  MsqDetails,
  QuestionType,
  RankOptionsDetails,
} from './types';
import {
  DEFAULT_SECTION,
  DEFAULT_TEAM,
  LIMITS,
  RowError,
  StudentInput,
  normalizeEmail,
  validateStudentFields,
} from './validation';

// ---------------------------------------------------------------------------
// Generic CSV (RFC 4180)

const LINE_SEPARATOR = '\r\n';

/** Cells that a spreadsheet would run as a formula get a leading apostrophe. */
export function neutralizeFormula(cell: string): string {
  return /^[=+@\t\r]/.test(cell) || /^-(?![\d.]+$)/.test(cell) ? `'${cell}` : cell;
}

export interface ToCsvOptions {
  /** Prefix cells that start with = + @ (or - before a non-number) with an apostrophe. Default false. */
  neutralize?: boolean;
}

/** Rows to a CSV string, CRLF between rows, no trailing newline. Cells with , " CR or LF are quoted. */
export function toCsv(rows: readonly (readonly string[])[], opts: ToCsvOptions = {}): string {
  return rows
    .map((row) =>
      row
        .map((raw) => {
          const cell = opts.neutralize ? neutralizeFormula(raw) : raw;
          return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
        })
        .join(','),
    )
    .join(LINE_SEPARATOR);
}

/**
 * Parse CSV text into rows of cells. Handles quoted fields with embedded commas, quotes ("") and
 * line breaks, CRLF, LF and CR line ends, and a leading byte order mark. `delimiter` defaults to ','
 * and is auto-switched to a tab when the first line has tabs and no commas (pasted spreadsheet cells).
 * A line break at the very end does not create an extra row; blank lines come back as [''].
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (src === '') return [];
  if (delimiter === undefined) {
    const firstLine = src.split(/\r\n|\r|\n/, 1)[0];
    delimiter = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  let cellStarted = false;
  src = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = '';
    cellStarted = false;
  };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && !cellStarted) {
      inQuotes = true;
      cellStarted = true;
      i++;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
      cellStarted = false;
      i++;
    } else if (ch === '\n') {
      endRow();
      i++;
    } else {
      cell += ch;
      cellStarted = true;
      i++;
    }
  }
  if (cell !== '' || cellStarted || row.length > 0) endRow();
  return rows;
}

const isBlankRow = (r: readonly string[]): boolean => r.every((c) => c.trim() === '');
const squash = (s: string): string => s.trim().replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------
// Roster CSV (spec section j)

export const ROSTER_HEADER = ['Section', 'Team', 'Name', 'Email', 'Comments'] as const;
type RosterColumn = 'section' | 'team' | 'name' | 'email' | 'comments';
const ROSTER_COLUMNS: readonly RosterColumn[] = ['section', 'team', 'name', 'email', 'comments'];

export interface RosterRow extends StudentInput {
  /** 1-based data row number in the source (header excluded, blank rows counted). */
  row: number;
}

export interface RosterParseResult {
  /** Every non-blank row, trimmed, with defaults filled and email lowercased, valid or not. */
  rows: RosterRow[];
  /** Rows without errors, ready for enroll_students. */
  valid: RosterRow[];
  errors: RowError[];
  /** True when the first row was read as a header. */
  hadHeader: boolean;
}

export interface RosterParseOptions {
  /** Students already in the course (email and section), used for the section size limit and email updates. */
  existing?: readonly { email: string; section: string }[];
}

function rowError(row: number, code: ErrorCode, field?: string): RowError {
  return { row, code, field, message: makeError(code).message };
}

/**
 * Parse pasted or uploaded roster text.
 *
 * Columns are Section, Team, Name, Email, Comments. The first row is a header when it names both
 * "name" and "email" (case-insensitive); a header may list the columns in another order or leave
 * out Section, Team or Comments. Without a header the order is fixed. Empty Section and Team become
 * "Default Section" and "Default Team". Text is trimmed and inner whitespace runs are squashed in
 * Section, Team and Name; email is lowercased.
 *
 * Errors, per row (limits from spec section j): required_field_missing, too_long, forbidden_char,
 * invalid_email, team_looks_like_email, wrong_column_count (a non-empty cell beyond the fifth),
 * duplicate_email (second and later rows with the same email), section_too_large (rows that would
 * take a section above 100 students, counting `existing` students who are not updated by this input).
 * A header without Name and Email columns is reported on row 0.
 */
export function parseRosterCsv(text: string, opts: RosterParseOptions = {}): RosterParseResult {
  const records = parseCsv(text);
  const errors: RowError[] = [];
  let columns: (RosterColumn | null)[] = [...ROSTER_COLUMNS];
  let hadHeader = false;
  let start = 0;

  if (records.length > 0) {
    const names = records[0].map((c) => c.trim().toLowerCase());
    if (names.includes('name') && names.includes('email')) {
      hadHeader = true;
      start = 1;
      columns = names.map((n) => ((ROSTER_COLUMNS as readonly string[]).includes(n) ? (n as RosterColumn) : null));
    } else if (names.includes('name') !== names.includes('email') && names.some((n) => n === 'section' || n === 'team')) {
      // Looks like a header with a missing required column.
      errors.push(rowError(0, 'required_field_missing', names.includes('name') ? 'email' : 'name'));
      return { rows: [], valid: [], errors, hadHeader: true };
    }
  }

  const rows: RosterRow[] = [];
  records.slice(start).forEach((cells, idx) => {
    const rowNo = idx + 1;
    if (isBlankRow(cells)) return;
    const get = (col: RosterColumn): string => {
      const i = columns.indexOf(col);
      return i < 0 ? '' : (cells[i] ?? '');
    };
    const extra = hadHeader ? cells.filter((c, i) => columns[i] === null && c.trim() !== '').length > 0 : cells.slice(5).some((c) => c.trim() !== '');
    const row: RosterRow = {
      row: rowNo,
      section: squash(get('section')) || DEFAULT_SECTION,
      team: squash(get('team')) || DEFAULT_TEAM,
      name: squash(get('name')),
      email: normalizeEmail(get('email')),
      comments: get('comments').trim(),
    };
    rows.push(row);
    if (extra) errors.push(rowError(rowNo, 'wrong_column_count'));
    for (const e of validateStudentFields(row)) errors.push(rowError(rowNo, e.code, e.field));
  });

  // Duplicate emails inside the input.
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.email === '') continue;
    if (seen.has(r.email)) errors.push(rowError(r.row, 'duplicate_email', 'email'));
    seen.add(r.email);
  }

  // Section size: existing students who are not in this input stay where they are.
  const incoming = new Set(rows.map((r) => r.email));
  const sizes = new Map<string, number>();
  for (const e of opts.existing ?? []) {
    if (!incoming.has(normalizeEmail(e.email))) sizes.set(e.section, (sizes.get(e.section) ?? 0) + 1);
  }
  const counted = new Set<string>();
  for (const r of rows) {
    if (counted.has(r.email)) continue; // a repeated email is already an error and counts once
    counted.add(r.email);
    const n = (sizes.get(r.section) ?? 0) + 1;
    sizes.set(r.section, n);
    if (n > LIMITS.sectionSize) errors.push(rowError(r.row, 'section_too_large', 'section'));
  }

  errors.sort((a, b) => a.row - b.row);
  const bad = new Set(errors.map((e) => e.row));
  return { rows, valid: rows.filter((r) => !bad.has(r.row)), errors, hadHeader };
}

/** Roster export in the same format the parser reads, with a header row. */
export function buildRosterCsv(students: readonly { section: string; team: string; name: string; email: string; comments?: string | null }[]): string {
  const rows: string[][] = [[...ROSTER_HEADER]];
  for (const s of students) rows.push([s.section, s.team, s.name, s.email, s.comments ?? '']);
  return toCsv(rows, { neutralize: true });
}

// ---------------------------------------------------------------------------
// Student links CSV

export const LINKS_HEADER = ['Section', 'Team', 'Name', 'Email', 'Link'] as const;

/** `<appUrl>/#/s/<token>` with any trailing slash on appUrl removed (ARCHITECTURE.md section 4). */
export function studentLink(appUrl: string, accessToken: string): string {
  return `${appUrl.replace(/\/+$/, '')}/#/s/${accessToken}`;
}

/** CSV of every student's personal link, for mail merge. Cells are formula-safe. */
export function buildStudentLinksCsv(
  students: readonly { section: string; team: string; name: string; email: string; token: string }[],
  appUrl: string,
): string {
  const rows: string[][] = [[...LINKS_HEADER]];
  for (const s of students) rows.push([s.section, s.team, s.name, s.email, studentLink(appUrl, s.token)]);
  return toCsv(rows, { neutralize: true });
}

/** Instructor "students who have not responded" CSV: Team, Name, Email (spec section k). */
export function buildNonSubmitterCsv(students: readonly { team: string; name: string; email: string }[]): string {
  if (students.length === 0) return '';
  const rows: string[][] = [['Participants who have not responded to any question'], [], ['Team', 'Name', 'Email']];
  for (const s of students) rows.push([s.team, s.name, s.email]);
  return toCsv(rows, { neutralize: true });
}

// ---------------------------------------------------------------------------
// Results CSV (spec section k)

export interface ResultsParty {
  /** Giver or recipient key (`s:`, `i:`, `t:` or 'none'). */
  key: string;
  name: string;
  email: string;
  team: string;
  kind?: StatRecipient['kind'];
  /** Team key, used for rank-in-team and contrib teams. */
  team_key?: string | null;
}

export interface ResultsResponse {
  giver: ResultsParty;
  recipient: ResultsParty;
  /** The stored answer, or null for a missing response ("No Response" row). */
  answer: unknown;
  giver_comment: string | null;
}

export interface ResultsQuestion {
  number: number;
  brief: string;
  type: QuestionType;
  details: unknown;
  responses: ResultsResponse[];
  /** Contrib only: every member of every team, so members who did not respond still get a statistics row. */
  contribMembers?: ResultsParty[];
  /**
   * Contrib only: the teams from the stored response rows (results.contribTeamsFromRows). When present they
   * are used as they are, so the CSV agrees with instructor_contrib_results after team changes.
   */
  contribTeams?: ContribTeam[];
}

export interface ResultsCsvOptions {
  /** Add the "Summary Statistics" block per question. */
  includeStats?: boolean;
  /** Keep rows whose answer is null ("No Response"). Default true. */
  indicateMissing?: boolean;
  /** Optional rows at the top: `Section Name` and `Section View Detail`. */
  sectionName?: string;
  sectionDetail?: string;
}

/** Column headers after the six participant columns and before "Giver's Comment". */
export function answerColumnHeaders(type: QuestionType, details: unknown): string[] {
  switch (type) {
    case 'msq':
      return ['Feedback', ...((details as MsqDetails).choices ?? [])];
    case 'constsum_options':
      return ['Feedback', ...((details as ConstsumOptionsDetails).options ?? [])];
    case 'rank_options':
      return ['Feedback', ...((details as RankOptionsDetails).options ?? []).map((_, i) => `Rank ${i + 1}`)];
    case 'rubric':
      return ['Sub Question', 'Choice Value', 'Choice Number'];
    default:
      return ['Feedback'];
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The answer cells for one response: one row, or one row per sub-question for rubric. */
export function answerCells(type: QuestionType, details: unknown, answer: unknown): string[][] {
  const d = isObj(details) ? details : {};
  const a = isObj(answer) ? answer : {};
  switch (type) {
    case 'msq': {
      const choices = Array.isArray(d.choices) ? (d.choices as string[]) : [];
      const picked = Array.isArray(a.choices) ? (a.choices as string[]) : [];
      const other = typeof a.other === 'string' ? a.other : '';
      // Feedback column holds the "other" text; one column per listed choice holds the choice when picked.
      return [[other, ...choices.map((c) => (picked.includes(c) ? c : ''))]];
    }
    case 'constsum_options':
      return [['', ...(Array.isArray(a.points) ? a.points.map(String) : [])]];
    case 'rank_options': {
      const options = Array.isArray(d.options) ? (d.options as string[]) : [];
      const ranks = Array.isArray(a.ranks) ? (a.ranks as (number | null)[]) : [];
      const cols = options.map((_, i) => options.filter((__, j) => ranks[j] === i + 1).join(', '));
      return [['', ...cols]];
    }
    case 'rubric': {
      const choices = Array.isArray(d.choices) ? (d.choices as string[]) : [];
      const picks = Array.isArray(a.choices) ? (a.choices as number[]) : [];
      return picks.map((c, i) => {
        const chosen = typeof c === 'number' && c >= 0;
        return [alphabeticalIndex(i + 1), chosen ? (choices[c] ?? '') : NO_RESPONSE_TEXT, chosen ? String(c + 1) : ''];
      });
    }
    case 'numscale':
      return [[typeof a.value === 'number' ? numberText(a.value) : '']];
    case 'contrib':
      return [[typeof a.value === 'number' ? contribValueText(a.value) : '']];
    default:
      return [[answerText({ type, details }, answer)]];
  }
}

function missingCells(type: QuestionType): string[][] {
  return type === 'rubric' ? [['All Sub-Questions', NO_RESPONSE_TEXT]] : [[NO_RESPONSE_TEXT]];
}

/** The statistics block of a question as CSV rows (without the "Summary Statistics" title), [] when none. */
export function statsRows(stats: QuestionStats | null): string[][] {
  if (stats === null) return [];
  const s = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v));
  switch (stats.kind) {
    case 'numscale': {
      if (stats.rows.length === 0) return [];
      const ex = stats.rows.some((r) => r.average_excluding_self !== null);
      const header = ['Team', 'Recipient', 'Recipient Email', 'Average', 'Minimum', 'Maximum'];
      if (ex) header.push('Average excluding self response');
      return [
        header,
        ...stats.rows.map((r) => {
          const row = [r.team, r.name, r.email ?? '', s(r.average), s(r.min), s(r.max)];
          if (ex) row.push(s(r.average_excluding_self));
          return row;
        }),
      ];
    }
    case 'choice':
      if (!stats.has_answers) return [];
      return [['Choice', 'Response Count', 'Percentage (%)'], ...stats.rows.map((r) => [r.option, String(r.count), String(r.percentage)])];
    case 'constsum_options':
      if (stats.rows.length === 0) return [];
      return [
        ['Option', 'Total Points', 'Average Points', 'Points Received'],
        ...stats.rows.map((r) => [r.option, String(r.total), String(r.average), ...r.points_received.map(String)]),
      ];
    case 'constsum_recipients':
      if (stats.rows.length === 0) return [];
      return [
        ['Team', 'Recipient', 'Recipient Email', 'Total Points', 'Average Points', 'Points Received'],
        ...stats.rows.map((r) => [r.team, r.name, r.email ?? '', String(r.total), String(r.average), ...r.points_received.map(String)]),
      ];
    case 'contrib':
      if (stats.rows.length === 0) return [];
      return [
        ['In the points given below, an equal share is equal to 100 points. e.g. 80 means "Equal share - 20%" and 110 means "Equal share + 10%".'],
        ['Claimed Contribution (CC) = the contribution claimed by the student.'],
        ["Perceived Contribution (PC) = the average value of student's contribution as perceived by the team members."],
        ['Team', 'Name', 'Email', 'CC', 'PC', 'Ratings Received'],
        ...stats.rows.map((r) => [
          r.team,
          r.name,
          r.email,
          contribPointToText(r.claimed),
          contribPointToText(r.perceived),
          ...(r.ratings_received.length === 0 ? ['N/A'] : r.ratings_received.map(contribPointToText)),
        ]),
      ];
    case 'rubric': {
      const rows: string[][] = [['', ...stats.choices]];
      stats.rows.forEach((r, i) => {
        rows.push([`${alphabeticalIndex(i + 1)}) ${r.sub_question}`, ...r.cells.map((c) => `${c.percentage}% (${c.count})`)]);
      });
      return rows;
    }
    case 'rank_options':
      if (stats.rows.length === 0) return [];
      return [['Option', 'Overall Rank', 'Ranks Received'], ...stats.rows.map((r) => [r.option, s(r.overall_rank), ...r.ranks_received.map(String)])];
    case 'rank_recipients': {
      if (stats.rows.length === 0) return [];
      const dash = (v: number | null) => (v === null ? '-' : String(v));
      return [
        ['Team', 'Recipient', 'Recipient Email', 'Self Rank', 'Overall Rank', 'Overall Rank Excluding Self', 'Team Rank', 'Team Rank Excluding Self', 'Ranks Received'],
        ...stats.rows.map((r) => [
          r.team,
          r.name,
          r.email ?? '',
          dash(r.self_rank),
          dash(r.overall_rank),
          dash(r.rank_excluding_self),
          dash(r.rank_in_team),
          dash(r.rank_in_team_excluding_self),
          ...r.ranks_received.map(String),
        ]),
      ];
    }
  }
}

function statRecipient(p: ResultsParty): StatRecipient {
  const kind = p.kind ?? (p.key === 'none' ? 'none' : p.key.startsWith('i:') ? 'instructor' : p.key.startsWith('t:') ? 'team' : 'student');
  return { key: p.key, name: p.name, email: p.email === '' ? null : p.email, team: p.team, team_key: p.team_key ?? null, kind };
}

/** Teams for contrib statistics: members from `contribMembers` plus every giver and recipient seen in responses. */
function contribTeamsFor(q: ResultsQuestion): ContribTeam[] {
  if (q.contribTeams) return q.contribTeams;
  const teams = new Map<string, ContribTeam>();
  const add = (p: ResultsParty) => {
    if (!p.key.startsWith('s:')) return;
    const tk = p.team_key ?? p.team;
    let t = teams.get(tk);
    if (!t) {
      t = { team_key: tk, team: p.team, members: [] };
      teams.set(tk, t);
    }
    if (!t.members.some((m) => m.key === p.key)) t.members.push({ key: p.key, name: p.name, email: p.email });
  };
  for (const m of q.contribMembers ?? []) add(m);
  for (const r of q.responses) {
    add(r.giver);
    add(r.recipient);
  }
  return [...teams.values()];
}

function questionStatistics(q: ResultsQuestion): QuestionStats | null {
  const real: StatResponse[] = q.responses
    .filter((r) => r.answer !== null && r.answer !== undefined)
    .map((r) => ({ giver_key: r.giver.key, recipient: statRecipient(r.recipient), answer: r.answer }));
  return questionStats(q.type, q.details, real, q.type === 'contrib' ? contribTeamsFor(q) : []);
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Results CSV in the TEAMMATES layout (spec section k), CRLF line ends.
 *
 * Optional `Section Name` and `Section View Detail` rows, then two blank rows. Per question, in number
 * order: `Question N, brief`, a blank row, an optional `Summary Statistics` block, the header row
 * (`Team, Giver's Name, Giver's Email, Recipient's Team, Recipient's Name, Recipient's Email`, the
 * type-specific columns, `Giver's Comment`), the response rows sorted by giver team, giver, recipient
 * team, recipient, and two blank rows. Missing responses show `No Response`.
 * Cells are made formula-safe (see neutralizeFormula). Instructor comment columns are not built.
 */
export function buildResultsCsv(questions: readonly ResultsQuestion[], opts: ResultsCsvOptions = {}): string {
  const out: string[][] = [];
  if (opts.sectionName) out.push(['Section Name', opts.sectionName]);
  if (opts.sectionDetail) out.push(['Section View Detail', opts.sectionDetail]);
  out.push([], []);

  for (const q of [...questions].sort((a, b) => a.number - b.number)) {
    out.push([`Question ${q.number}`, q.brief], []);

    if (opts.includeStats) {
      const rows = statsRows(questionStatistics(q));
      if (rows.length > 0) out.push(['Summary Statistics'], ...rows, [], []);
    }

    const specific = answerColumnHeaders(q.type, q.details);
    out.push(['Team', "Giver's Name", "Giver's Email", "Recipient's Team", "Recipient's Name", "Recipient's Email", ...specific, "Giver's Comment"]);

    const responses = q.responses
      .filter((r) => opts.indicateMissing !== false || (r.answer !== null && r.answer !== undefined))
      .sort(
        (a, b) =>
          cmpStr(a.giver.team, b.giver.team) ||
          cmpStr(a.giver.name, b.giver.name) ||
          cmpStr(a.recipient.team, b.recipient.team) ||
          cmpStr(a.recipient.name, b.recipient.name),
      );

    for (const r of responses) {
      const missing = r.answer === null || r.answer === undefined;
      const cells = missing ? missingCells(q.type) : answerCells(q.type, q.details, r.answer);
      cells[0] = [...cells[0], ...Array<string>(Math.max(0, specific.length - cells[0].length)).fill('')];
      for (const answerRow of cells) {
        out.push([
          squash(r.giver.team),
          squash(r.giver.name),
          squash(r.giver.email),
          squash(r.recipient.team),
          squash(r.recipient.name),
          squash(r.recipient.email),
          ...answerRow,
          r.giver_comment ?? '',
        ]);
      }
    }
    out.push([], []);
  }
  return toCsv(out, { neutralize: true });
}
