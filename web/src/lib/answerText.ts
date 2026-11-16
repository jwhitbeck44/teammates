// Plain-text rendering of one answer, for tables and CSV (spec sections b and k).
// Inputs are stored JSON and may be malformed, so every shape is checked; a bad shape gives ''.

import { CONTRIB_NOT_SURE, QuestionType } from './types';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The parts of a question that answer text depends on. A full `Question` satisfies it. */
export interface AnswerTextQuestion {
  type: QuestionType;
  details: unknown;
}

export const NO_RESPONSE_TEXT = 'No Response';
export const NONE_OF_THE_ABOVE_TEXT = 'None of the above';

/**
 * Text for a raw CONTRIB value (spec section b): above 100 "Equal share + N%", 100 "Equal share",
 * 1 to 99 "Equal share - N%", 0 "0%", -101 "Not Sure". Anything else gives ''.
 */
export function contribValueText(value: number): string {
  if (value === CONTRIB_NOT_SURE) return 'Not Sure';
  if (value > 100) return `Equal share + ${value - 100}%`;
  if (value === 100) return 'Equal share';
  if (value > 0) return `Equal share - ${100 - value}%`;
  if (value === 0) return '0%';
  return '';
}

/** Numbers up to three decimals, without trailing zeros (as TEAMMATES' numscale CSV does). */
export function numberText(value: number): string {
  return String(Math.round((value + Number.EPSILON) * 1000) / 1000);
}

/** 1 -> a, 2 -> b, ... 26 -> z, 27 -> aa (TEAMMATES StringHelper.integerToLowerCaseAlphabeticalIndex). */
export function alphabeticalIndex(n: number): string {
  let result = '';
  let n0 = n;
  while (n0 > 0) {
    n0 -= 1;
    const remainder = n0 % 26;
    result += String.fromCharCode(remainder + 97);
    n0 = (n0 - remainder) / 26;
  }
  return result;
}

/**
 * One-line text for an answer. Options and choices are taken from the question details so the
 * text is readable without the question.
 *
 * - text: the text. mcq: the choice or the "other" text. msq: choices joined with ", ", the "other"
 *   text last, or "None of the above" when nothing was picked.
 * - numscale: the number. constsum_options: "Option: points" pairs. constsum_recipients: the points.
 * - contrib: "Equal share + N%" wording. rubric: "a) Sub-question: Choice" pairs joined with "; ".
 * - rank_options: "Option: rank" pairs for ranked options. rank_recipients: the rank.
 */
export function answerText(question: AnswerTextQuestion, answer: unknown): string {
  if (!isObj(answer)) return '';
  const d = isObj(question.details) ? question.details : {};
  switch (question.type) {
    case 'text':
      return typeof answer.text === 'string' ? answer.text : '';
    case 'mcq':
      if (typeof answer.other === 'string') return answer.other;
      return typeof answer.choice === 'string' ? answer.choice : '';
    case 'msq': {
      if (!isStrArray(answer.choices)) return '';
      const parts = [...answer.choices];
      if (typeof answer.other === 'string' && answer.other !== '') parts.push(answer.other);
      return parts.length === 0 ? NONE_OF_THE_ABOVE_TEXT : parts.join(', ');
    }
    case 'numscale':
      return typeof answer.value === 'number' ? numberText(answer.value) : '';
    case 'constsum_options': {
      if (!Array.isArray(answer.points)) return '';
      const options = isStrArray(d.options) ? d.options : [];
      return answer.points.map((p, i) => `${options[i] ?? `Option ${i + 1}`}: ${String(p)}`).join(', ');
    }
    case 'constsum_recipients':
      return typeof answer.points === 'number' ? String(answer.points) : '';
    case 'contrib':
      return typeof answer.value === 'number' ? contribValueText(answer.value) : '';
    case 'rubric': {
      if (!Array.isArray(answer.choices)) return '';
      const choices = isStrArray(d.choices) ? d.choices : [];
      const subs = isStrArray(d.subQuestions) ? d.subQuestions : [];
      return answer.choices
        .map((c, i) => {
          const label = `${alphabeticalIndex(i + 1)}) ${subs[i] ?? ''}`.trimEnd();
          const picked = typeof c === 'number' && c >= 0 ? (choices[c] ?? '') : NO_RESPONSE_TEXT;
          return `${label}: ${picked}`;
        })
        .join('; ');
    }
    case 'rank_options': {
      if (!Array.isArray(answer.ranks)) return '';
      const options = isStrArray(d.options) ? d.options : [];
      const parts: string[] = [];
      answer.ranks.forEach((r, i) => {
        if (typeof r === 'number') parts.push(`${options[i] ?? `Option ${i + 1}`}: ${r}`);
      });
      return parts.join(', ');
    }
    case 'rank_recipients':
      return typeof answer.rank === 'number' ? String(answer.rank) : '';
    default:
      return '';
  }
}
