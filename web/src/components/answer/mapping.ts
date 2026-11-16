// Pure mapping between what the student sees in the inputs and the answer JSON the SQL expects
// (ARCHITECTURE.md section 6). No React. Inputs hold strings so that half-typed values survive.

import { CONTRIB_NOT_SURE, RUBRIC_UNANSWERED, QuestionType } from '../../lib/types';
import type { DetailsByType } from '../../lib/types';
import { contribValueText } from '../../lib/answerText';

export type AnswerInput =
  | { type: 'text'; text: string }
  | { type: 'mcq'; choice: string | null; otherSelected: boolean; other: string }
  | { type: 'msq'; choices: string[]; otherChecked: boolean; other: string; none: boolean }
  | { type: 'numscale'; value: string }
  | { type: 'constsum_options'; points: string[] }
  | { type: 'constsum_recipients'; points: string }
  | { type: 'contrib'; value: string }
  | { type: 'rubric'; choices: number[] }
  | { type: 'rank_options'; ranks: string[] }
  | { type: 'rank_recipients'; rank: string };

/** Value of the contribution select for "Not sure". */
export const CONTRIB_NOT_SURE_VALUE = 'ns';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** '' (or spaces) gives null; anything else gives Number(...), which may be NaN. */
export function parseNumber(s: string): number | null {
  const t = s.trim();
  return t === '' ? null : Number(t);
}

type Details<T extends QuestionType> = DetailsByType[T];

/** The blank input for a question type. */
export function emptyInput<T extends QuestionType>(type: T, details: Details<T>): AnswerInput {
  switch (type) {
    case 'text':
      return { type: 'text', text: '' };
    case 'mcq':
      return { type: 'mcq', choice: null, otherSelected: false, other: '' };
    case 'msq':
      return { type: 'msq', choices: [], otherChecked: false, other: '', none: false };
    case 'numscale':
      return { type: 'numscale', value: '' };
    case 'constsum_options':
      return { type: 'constsum_options', points: (details as Details<'constsum_options'>).options.map(() => '') };
    case 'constsum_recipients':
      return { type: 'constsum_recipients', points: '' };
    case 'contrib':
      return { type: 'contrib', value: '' };
    case 'rubric':
      return { type: 'rubric', choices: (details as Details<'rubric'>).subQuestions.map(() => RUBRIC_UNANSWERED) };
    case 'rank_options':
      return { type: 'rank_options', ranks: (details as Details<'rank_options'>).options.map(() => '') };
    case 'rank_recipients':
      return { type: 'rank_recipients', rank: '' };
    default:
      throw new Error(`unknown question type ${String(type)}`);
  }
}

/**
 * Input state from a saved answer. A malformed or missing answer gives the blank input.
 */
export function inputFromAnswer<T extends QuestionType>(type: T, details: Details<T>, answer: unknown): AnswerInput {
  const blankInput = emptyInput(type, details);
  if (!isObj(answer)) return blankInput;
  switch (type) {
    case 'text':
      return typeof answer.text === 'string' ? { type: 'text', text: answer.text } : blankInput;
    case 'mcq':
      if (typeof answer.other === 'string') return { type: 'mcq', choice: null, otherSelected: true, other: answer.other };
      if (typeof answer.choice === 'string') return { type: 'mcq', choice: answer.choice, otherSelected: false, other: '' };
      return blankInput;
    case 'msq': {
      if (!isStrArray(answer.choices)) return blankInput;
      const hasOther = typeof answer.other === 'string';
      return {
        type: 'msq',
        choices: answer.choices,
        otherChecked: hasOther,
        other: hasOther ? (answer.other as string) : '',
        none: answer.choices.length === 0 && !hasOther,
      };
    }
    case 'numscale':
      return typeof answer.value === 'number' ? { type: 'numscale', value: String(answer.value) } : blankInput;
    case 'constsum_options': {
      const n = (details as Details<'constsum_options'>).options.length;
      if (!Array.isArray(answer.points)) return blankInput;
      const pts = answer.points as unknown[];
      return {
        type: 'constsum_options',
        points: Array.from({ length: n }, (_, i) => (typeof pts[i] === 'number' ? String(pts[i]) : '')),
      };
    }
    case 'constsum_recipients':
      return typeof answer.points === 'number' ? { type: 'constsum_recipients', points: String(answer.points) } : blankInput;
    case 'contrib':
      if (typeof answer.value !== 'number') return blankInput;
      return { type: 'contrib', value: answer.value === CONTRIB_NOT_SURE ? CONTRIB_NOT_SURE_VALUE : String(answer.value) };
    case 'rubric': {
      const n = (details as Details<'rubric'>).subQuestions.length;
      if (!Array.isArray(answer.choices)) return blankInput;
      const c = answer.choices as unknown[];
      return {
        type: 'rubric',
        choices: Array.from({ length: n }, (_, i) => (typeof c[i] === 'number' ? (c[i] as number) : RUBRIC_UNANSWERED)),
      };
    }
    case 'rank_options': {
      const n = (details as Details<'rank_options'>).options.length;
      if (!Array.isArray(answer.ranks)) return blankInput;
      const r = answer.ranks as unknown[];
      return {
        type: 'rank_options',
        ranks: Array.from({ length: n }, (_, i) => (typeof r[i] === 'number' ? String(r[i]) : '')),
      };
    }
    case 'rank_recipients':
      return typeof answer.rank === 'number' ? { type: 'rank_recipients', rank: String(answer.rank) } : blankInput;
    default:
      return blankInput;
  }
}

/**
 * The answer JSON for an input, or null when the input is blank (a blank row is not sent).
 * Values that are not valid (for example text in a number box) are passed on as NaN so that
 * validateAnswers reports them instead of the row silently disappearing.
 */
export function inputToAnswer<T extends QuestionType>(type: T, details: Details<T>, input: AnswerInput): unknown | null {
  if (input.type !== type) return null;
  switch (input.type) {
    case 'text': {
      const t = input.text.trim();
      return t === '' ? null : { text: t };
    }
    case 'mcq':
      if (input.otherSelected) return { other: input.other.trim() };
      return input.choice === null ? null : { choice: input.choice };
    case 'msq': {
      if (input.none) return { choices: [] };
      if (input.choices.length === 0 && !input.otherChecked) return null;
      const order = (details as Details<'msq'>).choices;
      // Keep the question's order, not the click order.
      const picked = order.filter((c) => input.choices.includes(c));
      return input.otherChecked ? { choices: picked, other: input.other.trim() } : { choices: picked };
    }
    case 'numscale': {
      const n = parseNumber(input.value);
      return n === null ? null : { value: n };
    }
    case 'constsum_options': {
      if (input.points.every((p) => p.trim() === '')) return null;
      return { points: input.points.map((p) => parseNumber(p) ?? 0) };
    }
    case 'constsum_recipients': {
      const n = parseNumber(input.points);
      return n === null ? null : { points: n };
    }
    case 'contrib': {
      if (input.value === '') return null;
      if (input.value === CONTRIB_NOT_SURE_VALUE) return { value: CONTRIB_NOT_SURE };
      return { value: Number(input.value) };
    }
    case 'rubric':
      return input.choices.every((c) => c === RUBRIC_UNANSWERED) ? null : { choices: [...input.choices] };
    case 'rank_options': {
      if (input.ranks.every((r) => r.trim() === '')) return null;
      return { ranks: input.ranks.map((r) => parseNumber(r)) };
    }
    case 'rank_recipients': {
      const n = parseNumber(input.rank);
      return n === null ? null : { rank: n };
    }
  }
}

// ---------------------------------------------------------------------------
// Contribution select

export interface SelectOption {
  value: string;
  label: string;
}

/** 0..200 in steps of 5, worded as in TEAMMATES, plus "Not sure" when allowed. */
export function contribOptions(isNotSureAllowed: boolean): SelectOption[] {
  const out: SelectOption[] = [];
  for (let v = 0; v <= 200; v += 5) out.push({ value: String(v), label: contribValueText(v) });
  if (isNotSureAllowed) out.push({ value: CONTRIB_NOT_SURE_VALUE, label: 'Not sure' });
  return out;
}

/** Sum of the numeric contribution values of the given inputs (blank and "Not sure" count as 0). */
export function contribTotal(values: readonly string[]): number {
  let sum = 0;
  for (const v of values) {
    const n = v === '' || v === CONTRIB_NOT_SURE_VALUE ? 0 : Number(v);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

/** The zero-sum target for a team of `size` people. */
export function contribTarget(size: number): number {
  return 100 * size;
}

// ---------------------------------------------------------------------------
// Constant-sum helpers

/** Sum of the typed numbers; blank and invalid entries count as 0. */
export function sumPoints(values: readonly string[]): number {
  let sum = 0;
  for (const v of values) {
    const n = parseNumber(v);
    if (n !== null && Number.isFinite(n)) sum += n;
  }
  return sum;
}

/** The total the points must add up to. `rows` is the number of options or answered recipients. */
export function constsumTarget(d: { points: number; pointsPerOption: boolean }, rows: number): number {
  return d.pointsPerOption ? d.points * rows : d.points;
}

/** Plain rules for a constant-sum question, in as few words as possible. */
export function constsumRules(d: {
  distribute: 'none' | 'some' | 'all';
  minPoint?: number;
  maxPoint?: number;
}): string[] {
  const out: string[] = [];
  if (d.minPoint != null) out.push(`At least ${d.minPoint} each.`);
  if (d.maxPoint != null) out.push(`At most ${d.maxPoint} each.`);
  if (d.distribute === 'some') out.push('Give at least two different numbers.');
  if (d.distribute === 'all') out.push('Every number must be different.');
  return out;
}

// ---------------------------------------------------------------------------
// Rank and choice rules

export function rankRules(d: { minToRank?: number; maxToRank?: number; duplicatesAllowed: boolean }): string[] {
  const out: string[] = [];
  if (d.minToRank != null) out.push(`Rank at least ${d.minToRank}.`);
  if (d.maxToRank != null) out.push(`Rank at most ${d.maxToRank}.`);
  out.push(d.duplicatesAllowed ? 'Ties are allowed.' : 'Use each rank once.');
  return out;
}

export function msqRules(d: { minSelectable?: number; maxSelectable?: number }): string[] {
  if (d.minSelectable != null && d.maxSelectable != null) {
    return d.minSelectable === d.maxSelectable
      ? [`Pick ${d.minSelectable}.`]
      : [`Pick ${d.minSelectable} to ${d.maxSelectable}.`];
  }
  if (d.minSelectable != null) return [`Pick at least ${d.minSelectable}.`];
  if (d.maxSelectable != null) return [`Pick at most ${d.maxSelectable}.`];
  return [];
}

/** "1".."n" for rank selects. */
export function rankChoices(n: number): string[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => String(i + 1));
}

/** Toggle one choice in an MSQ input, clearing "none of the above". */
export function toggleMsqChoice(input: Extract<AnswerInput, { type: 'msq' }>, choice: string, on: boolean) {
  const choices = on ? [...new Set([...input.choices, choice])] : input.choices.filter((c) => c !== choice);
  return { ...input, choices, none: false };
}
