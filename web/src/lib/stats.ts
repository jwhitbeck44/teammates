// Instructor statistics per question type, ported from the TEAMMATES calculators in
// logic/statistics/*QuestionStatisticsCalculator.java (spec section a). Pure functions over the
// responses of ONE question. Weights are not built (ARCHITECTURE.md section 3), so MCQ, MSQ and
// rubric statistics are the unweighted tables.
//
// Rules carried over from TEAMMATES:
// - Averages are rounded to two decimals with Java Math.round (floor(x + 0.5)), which JS Math.round matches.
// - "Excluding self" drops responses whose giver key equals the recipient key.
// - Rows are sorted by recipient team name, then recipient name (plain code point order).
// - Recipient-based statistics ignore responses with no recipient ('none').
// - Rank options: each response's ranks are compacted to dense ranks (1, 2, 3, ...) before they are
//   collected; rank recipients are not compacted. Overall rank orders by average rank, ties share a rank
//   and the next rank skips (1, 1, 3).

import { buildClaimedMatrix, calculateTeamEvalResult, contribRows } from './contrib';
import {
  ConstsumOptionsDetails,
  McqDetails,
  MsqDetails,
  QuestionType,
  RankOptionsDetails,
  RubricDetails,
} from './types';

// ---------------------------------------------------------------------------
// Input

export interface StatRecipient {
  key: string;
  name: string;
  email: string | null;
  /** Team name shown in tables; '' for instructors. */
  team: string;
  /** Team key (`t:<section>|<team>`) used for "rank in team"; falls back to `team` when absent. */
  team_key?: string | null;
  kind: 'student' | 'instructor' | 'team' | 'none';
}

export interface StatResponse<A = unknown> {
  giver_key: string;
  recipient: StatRecipient;
  answer: A;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Java `Math.round(value * 100.0) / 100.0`. */
export function round2(value: number): number {
  const r = Math.round(value * 100) / 100;
  return r === 0 ? 0 : r;
}

const isSelf = (r: StatResponse): boolean => r.giver_key === r.recipient.key;

function byTeamThenName<T extends { team: string; name: string }>(a: T, b: T): number {
  return cmp(a.team, b.team) || cmp(a.name, b.name);
}

const ascending = (a: number, b: number): number => a - b;

// ---------------------------------------------------------------------------
// Rank helpers (exported for tests)

/**
 * Map the ranks of one response to dense ranks: the distinct ranked values, sorted, become 1, 2, 3...
 * Entries that are null (not ranked) stay null.
 */
export function normalizeRanks(ranks: readonly (number | null)[]): (number | null)[] {
  const distinct = [...new Set(ranks.filter((r): r is number => r !== null))].sort(ascending);
  const map = new Map<number, number>(distinct.map((r, i) => [r, i + 1]));
  return ranks.map((r) => (r === null ? null : (map.get(r) as number)));
}

/**
 * Overall rank per key from the average of the ranks received. Keys without ranks are omitted.
 * Ties share the rank and the next rank skips: averages 1, 1, 2 give ranks 1, 1, 3.
 */
export function computeOverallRanks(ranksPerKey: ReadonlyMap<string, readonly number[]>): Map<string, number> {
  const averages: [string, number][] = [];
  for (const [key, ranks] of ranksPerKey) {
    if (ranks.length === 0) continue;
    averages.push([key, ranks.reduce((a, b) => a + b, 0) / ranks.length]);
  }
  // Array.prototype.sort is stable, like the Java stream sort, so ties keep insertion order.
  averages.sort((a, b) => a[1] - b[1]);
  const result = new Map<string, number>();
  averages.forEach(([key, avg], i) => {
    if (i === 0) result.set(key, 1);
    else {
      const [prevKey, prevAvg] = averages[i - 1];
      result.set(key, avg === prevAvg ? (result.get(prevKey) as number) : i + 1);
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// Numscale

export interface NumscaleRow {
  recipient_key: string;
  name: string;
  email: string | null;
  team: string;
  average: number;
  min: number;
  max: number;
  /** null when the recipient has only self responses. */
  average_excluding_self: number | null;
}

export function numscaleStats(responses: readonly StatResponse[]): { rows: NumscaleRow[] } {
  const acc = new Map<string, { r: StatRecipient; sum: number; n: number; min: number; max: number; sumEx: number; nEx: number }>();
  for (const resp of responses) {
    if (resp.recipient.kind === 'none' || !isObj(resp.answer) || typeof resp.answer.value !== 'number') continue;
    const v = resp.answer.value;
    let a = acc.get(resp.recipient.key);
    if (!a) {
      a = { r: resp.recipient, sum: 0, n: 0, min: v, max: v, sumEx: 0, nEx: 0 };
      acc.set(resp.recipient.key, a);
    }
    a.sum += v;
    a.n++;
    a.min = Math.min(a.min, v);
    a.max = Math.max(a.max, v);
    if (!isSelf(resp)) {
      a.sumEx += v;
      a.nEx++;
    }
  }
  const rows = [...acc.values()].map((a) => ({
    recipient_key: a.r.key,
    name: a.r.name,
    email: a.r.email,
    team: a.r.team,
    average: round2(a.sum / a.n),
    min: a.min,
    max: a.max,
    average_excluding_self: a.nEx > 0 ? round2(a.sumEx / a.nEx) : null,
  }));
  return { rows: rows.sort(byTeamThenName) };
}

// ---------------------------------------------------------------------------
// MCQ and MSQ

export const OTHER_LABEL = 'Other';

export interface ChoiceRow {
  option: string;
  count: number;
  /** Share of all counted answers, two decimals; 0 when nothing was answered. */
  percentage: number;
}

/**
 * Counts per choice. MCQ counts one per response ("Other" when an other text was given). MSQ counts
 * every picked choice and one "Other" per response that has an other text; "none of the above"
 * counts nothing. Percentages are over the total count (so MSQ percentages add to 100 over picks).
 */
export function choiceStats(
  details: McqDetails | MsqDetails,
  responses: readonly StatResponse[],
): { has_answers: boolean; total: number; rows: ChoiceRow[] } {
  const labels = [...details.choices];
  if (details.otherEnabled) labels.push(OTHER_LABEL);
  const counts = new Map<string, number>(labels.map((l) => [l, 0]));
  const bump = (label: string) => {
    if (counts.has(label)) counts.set(label, (counts.get(label) as number) + 1);
  };
  for (const resp of responses) {
    const a = resp.answer;
    if (!isObj(a)) continue;
    if (typeof a.other === 'string' && a.other !== '') bump(OTHER_LABEL);
    if (typeof a.choice === 'string') bump(a.choice);
    if (Array.isArray(a.choices)) for (const c of a.choices) if (typeof c === 'string') bump(c);
  }
  const total = [...counts.values()].reduce((x, y) => x + y, 0);
  const rows = labels.map((option) => {
    const count = counts.get(option) as number;
    return { option, count, percentage: total === 0 ? 0 : round2((100 * count) / total) };
  });
  return { has_answers: total > 0, total, rows };
}

// ---------------------------------------------------------------------------
// Constant sum

export interface ConstsumOptionRow {
  option: string;
  /** Sorted ascending. */
  points_received: number[];
  total: number;
  average: number;
}

export function constsumOptionsStats(
  details: ConstsumOptionsDetails,
  responses: readonly StatResponse[],
): { rows: ConstsumOptionRow[] } {
  const per: number[][] = details.options.map(() => []);
  for (const resp of responses) {
    const a = resp.answer;
    if (!isObj(a) || !Array.isArray(a.points)) continue;
    for (let i = 0; i < per.length && i < a.points.length; i++) {
      if (isInt(a.points[i])) per[i].push(a.points[i]);
    }
  }
  const rows = details.options.map((option, i) => {
    const pts = [...per[i]].sort(ascending);
    const total = pts.reduce((x, y) => x + y, 0);
    return { option, points_received: pts, total, average: pts.length === 0 ? 0 : round2(total / pts.length) };
  });
  return { rows };
}

export interface ConstsumRecipientRow {
  recipient_key: string;
  name: string;
  email: string | null;
  team: string;
  points_received: number[];
  total: number;
  average: number;
  average_excluding_self: number | null;
}

export function constsumRecipientsStats(responses: readonly StatResponse[]): { rows: ConstsumRecipientRow[] } {
  const acc = new Map<string, { r: StatRecipient; pts: number[]; ex: number[] }>();
  for (const resp of responses) {
    if (resp.recipient.kind === 'none' || !isObj(resp.answer) || !isInt(resp.answer.points)) continue;
    let a = acc.get(resp.recipient.key);
    if (!a) {
      a = { r: resp.recipient, pts: [], ex: [] };
      acc.set(resp.recipient.key, a);
    }
    a.pts.push(resp.answer.points);
    if (!isSelf(resp)) a.ex.push(resp.answer.points);
  }
  const sum = (l: number[]) => l.reduce((x, y) => x + y, 0);
  const rows = [...acc.values()].map((a) => ({
    recipient_key: a.r.key,
    name: a.r.name,
    email: a.r.email,
    team: a.r.team,
    points_received: [...a.pts].sort(ascending),
    total: sum(a.pts),
    average: round2(sum(a.pts) / a.pts.length),
    average_excluding_self: a.ex.length > 0 ? round2(sum(a.ex) / a.ex.length) : null,
  }));
  return { rows: rows.sort(byTeamThenName) };
}

// ---------------------------------------------------------------------------
// Rubric

export interface RubricCell {
  count: number;
  /** Share of the row, two decimals; 0 for an empty row. */
  percentage: number;
}
export interface RubricRow {
  sub_question: string;
  cells: RubricCell[];
}

export function rubricStats(
  details: RubricDetails,
  responses: readonly StatResponse[],
): { sub_questions: string[]; choices: string[]; rows: RubricRow[]; rows_exclude_self: RubricRow[] } {
  const nSub = details.subQuestions.length;
  const nCh = details.choices.length;
  const all = Array.from({ length: nSub }, () => Array<number>(nCh).fill(0));
  const ex = Array.from({ length: nSub }, () => Array<number>(nCh).fill(0));
  for (const resp of responses) {
    const a = resp.answer;
    if (!isObj(a) || !Array.isArray(a.choices)) continue;
    const self = isSelf(resp);
    for (let i = 0; i < a.choices.length && i < nSub; i++) {
      const c = a.choices[i];
      if (!isInt(c) || c < 0 || c >= nCh) continue; // -1 = not chosen
      all[i][c]++;
      if (!self) ex[i][c]++;
    }
  }
  const build = (m: number[][]): RubricRow[] =>
    m.map((counts, r) => {
      const rowSum = counts.reduce((x, y) => x + y, 0);
      return {
        sub_question: details.subQuestions[r],
        cells: counts.map((count) => ({ count, percentage: rowSum === 0 ? 0 : round2((100 * count) / rowSum) })),
      };
    });
  return { sub_questions: [...details.subQuestions], choices: [...details.choices], rows: build(all), rows_exclude_self: build(ex) };
}

// ---------------------------------------------------------------------------
// Rank

export interface RankOptionRow {
  option: string;
  /** Sorted ascending, after per-response compaction. */
  ranks_received: number[];
  /** null when nobody ranked the option. */
  overall_rank: number | null;
}

export function rankOptionsStats(details: RankOptionsDetails, responses: readonly StatResponse[]): { rows: RankOptionRow[] } {
  const per = new Map<string, number[]>(details.options.map((o) => [o, []]));
  for (const resp of responses) {
    const a = resp.answer;
    if (!isObj(a) || !Array.isArray(a.ranks)) continue;
    const ranks = a.ranks.map((r) => (isInt(r) ? r : null));
    const compact = normalizeRanks(ranks);
    for (let i = 0; i < details.options.length && i < compact.length; i++) {
      const r = compact[i];
      if (r !== null) (per.get(details.options[i]) as number[]).push(r);
    }
  }
  const overall = computeOverallRanks(per);
  return {
    rows: details.options.map((option) => ({
      option,
      ranks_received: [...(per.get(option) as number[])].sort(ascending),
      overall_rank: overall.get(option) ?? null,
    })),
  };
}

export interface RankRecipientRow {
  recipient_key: string;
  name: string;
  email: string | null;
  team: string;
  ranks_received: number[];
  self_rank: number | null;
  overall_rank: number | null;
  rank_excluding_self: number | null;
  rank_in_team: number | null;
  rank_in_team_excluding_self: number | null;
}

export function rankRecipientsStats(responses: readonly StatResponse[]): { rows: RankRecipientRow[] } {
  const acc = new Map<string, { r: StatRecipient; ranks: number[]; ex: number[]; self: number | null }>();
  for (const resp of responses) {
    if (!isObj(resp.answer) || !isInt(resp.answer.rank)) continue;
    let a = acc.get(resp.recipient.key);
    if (!a) {
      a = { r: resp.recipient, ranks: [], ex: [], self: null };
      acc.set(resp.recipient.key, a);
    }
    a.ranks.push(resp.answer.rank);
    if (isSelf(resp)) a.self = resp.answer.rank;
    else a.ex.push(resp.answer.rank);
  }
  const all = new Map<string, number[]>();
  const exAll = new Map<string, number[]>();
  for (const [k, a] of acc) {
    all.set(k, a.ranks);
    exAll.set(k, a.ex);
  }
  const overall = computeOverallRanks(all);
  const overallEx = computeOverallRanks(exAll);

  // Team ranks: student recipients only, grouped by team.
  const byTeam = new Map<string, string[]>();
  for (const [k, a] of acc) {
    if (a.r.kind !== 'student') continue;
    const t = a.r.team_key ?? a.r.team;
    byTeam.set(t, [...(byTeam.get(t) ?? []), k]);
  }
  const teamRank = new Map<string, number>();
  const teamRankEx = new Map<string, number>();
  for (const keys of byTeam.values()) {
    for (const [k, v] of computeOverallRanks(new Map(keys.map((x) => [x, (acc.get(x) as { ranks: number[] }).ranks])))) teamRank.set(k, v);
    for (const [k, v] of computeOverallRanks(new Map(keys.map((x) => [x, (acc.get(x) as { ex: number[] }).ex])))) teamRankEx.set(k, v);
  }

  const rows = [...acc.entries()].map(([k, a]) => ({
    recipient_key: k,
    name: a.r.name,
    email: a.r.email,
    team: a.r.team,
    ranks_received: [...a.ranks].sort(ascending),
    self_rank: a.self,
    overall_rank: overall.get(k) ?? null,
    rank_excluding_self: overallEx.get(k) ?? null,
    rank_in_team: teamRank.get(k) ?? null,
    rank_in_team_excluding_self: teamRankEx.get(k) ?? null,
  }));
  return { rows: rows.sort(byTeamThenName) };
}

// ---------------------------------------------------------------------------
// Contribution (instructor view; math in contrib.ts)

export interface ContribTeam {
  team_key: string;
  team: string;
  members: { key: string; name: string; email: string }[];
}

export interface ContribValueResponse {
  giver_key: string;
  recipient_key: string;
  value: number;
}

export interface ContribStatRow {
  team: string;
  name: string;
  email: string;
  member_key: string;
  /** CC: claimed contribution; NSU (-101) or NSB (-999) when not given. */
  claimed: number;
  /** PC: perceived contribution; NA (-9999) when nobody rated the member. */
  perceived: number;
  /** perceived - claimed, or -999 when either is negative. */
  diff: number;
  /** Ratings from the other members, descending. */
  ratings_received: number[];
}

/** One row per member of each team, ordered by team then name. */
export function contribStats(teams: readonly ContribTeam[], responses: readonly ContribValueResponse[]): { rows: ContribStatRow[] } {
  const rows: ContribStatRow[] = [];
  for (const t of teams) {
    const members = [...t.members].sort((a, b) => cmp(a.name, b.name) || cmp(a.key, b.key));
    const keys = members.map((m) => m.key);
    const result = calculateTeamEvalResult(buildClaimedMatrix(keys, responses));
    contribRows(keys, result).forEach((cr, i) => {
      rows.push({
        team: t.team,
        name: members[i].name,
        email: members[i].email,
        member_key: cr.member_key,
        claimed: cr.claimed,
        perceived: cr.perceived,
        diff: cr.diff,
        ratings_received: cr.ratings_received,
      });
    });
  }
  return { rows: rows.sort(byTeamThenName) };
}

// ---------------------------------------------------------------------------
// Dispatcher

export type QuestionStats =
  | ({ kind: 'numscale' } & ReturnType<typeof numscaleStats>)
  | ({ kind: 'choice' } & ReturnType<typeof choiceStats>)
  | ({ kind: 'constsum_options' } & ReturnType<typeof constsumOptionsStats>)
  | ({ kind: 'constsum_recipients' } & ReturnType<typeof constsumRecipientsStats>)
  | ({ kind: 'contrib' } & ReturnType<typeof contribStats>)
  | ({ kind: 'rubric' } & ReturnType<typeof rubricStats>)
  | ({ kind: 'rank_options' } & ReturnType<typeof rankOptionsStats>)
  | ({ kind: 'rank_recipients' } & ReturnType<typeof rankRecipientsStats>);

/**
 * Statistics for one question, or null for types without any (text).
 * `contribTeams` is required for contrib (every member of each team, so non-responders appear).
 * `details` must match the question type.
 */
export function questionStats(
  type: QuestionType,
  details: unknown,
  responses: readonly StatResponse[],
  contribTeams: readonly ContribTeam[] = [],
): QuestionStats | null {
  switch (type) {
    case 'text':
      return null;
    case 'numscale':
      return { kind: 'numscale', ...numscaleStats(responses) };
    case 'mcq':
    case 'msq':
      return { kind: 'choice', ...choiceStats(details as McqDetails | MsqDetails, responses) };
    case 'constsum_options':
      return { kind: 'constsum_options', ...constsumOptionsStats(details as ConstsumOptionsDetails, responses) };
    case 'constsum_recipients':
      return { kind: 'constsum_recipients', ...constsumRecipientsStats(responses) };
    case 'contrib': {
      const values: ContribValueResponse[] = [];
      for (const r of responses) {
        if (isObj(r.answer) && isInt(r.answer.value)) values.push({ giver_key: r.giver_key, recipient_key: r.recipient.key, value: r.answer.value });
      }
      return { kind: 'contrib', ...contribStats(contribTeams, values) };
    }
    case 'rubric':
      return { kind: 'rubric', ...rubricStats(details as RubricDetails, responses) };
    case 'rank_options':
      return { kind: 'rank_options', ...rankOptionsStats(details as RankOptionsDetails, responses) };
    case 'rank_recipients':
      return { kind: 'rank_recipients', ...rankRecipientsStats(responses) };
  }
}
