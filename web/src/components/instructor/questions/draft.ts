// Helpers for the question editor: default drafts per type, and the rule for when a change deletes responses.

import { allowedRecipientTypes } from '../../../lib/recipients';
import { defaultVisibility } from '../../../lib/visibility';
import type { QuestionDraft, QuestionType, RecipientType } from '../../../lib/types';

export const TYPE_LABELS: Record<QuestionType, string> = {
  text: 'Text (free answer)',
  mcq: 'Multiple choice (one answer)',
  msq: 'Multiple choice (several answers)',
  numscale: 'Number on a scale',
  constsum_options: 'Distribute points among options',
  constsum_recipients: 'Distribute points among recipients',
  contrib: 'Team contribution (percentage-based)',
  rubric: 'Rubric',
  rank_options: 'Rank options',
  rank_recipients: 'Rank recipients',
};

const PREFERRED_RECIPIENTS: RecipientType[] = ['own_team_members', 'students_excluding_self', 'students'];

/** A new, valid-looking draft of the given type. The caller sets `number`. */
export function defaultDraft(type: QuestionType, number: number): QuestionDraft {
  const allowed = allowedRecipientTypes('students', type);
  const recipient_type: RecipientType = PREFERRED_RECIPIENTS.find((r) => allowed.includes(r)) ?? allowed[0];
  const base = {
    number,
    brief: '',
    description: '',
    giver_type: 'students' as const,
    recipient_type,
    max_recipients: null,
    ...defaultVisibility(),
  };
  switch (type) {
    case 'text':
      return { ...base, type, details: {} };
    case 'mcq':
      return { ...base, type, details: { choices: ['Choice 1', 'Choice 2'], otherEnabled: false } };
    case 'msq':
      return { ...base, type, details: { choices: ['Choice 1', 'Choice 2'], otherEnabled: false } };
    case 'numscale':
      return { ...base, type, details: { min: 1, max: 5, step: 1 } };
    case 'constsum_options':
      return { ...base, type, details: { options: ['Option 1', 'Option 2'], points: 100, pointsPerOption: false, distribute: 'none' } };
    case 'constsum_recipients':
      return { ...base, type, details: { points: 100, pointsPerOption: true, distribute: 'none' } };
    case 'contrib':
      return { ...base, type, recipient_type: 'own_team_members_including_self', details: { isZeroSum: true, isNotSureAllowed: false } };
    case 'rubric':
      return {
        ...base,
        type,
        details: {
          choices: ['Strongly agree', 'Agree', 'Disagree', 'Strongly disagree'],
          subQuestions: ['Sub-question 1'],
          descriptions: [['', '', '', '']],
        },
      };
    case 'rank_options':
      return { ...base, type, details: { options: ['Option 1', 'Option 2'], duplicatesAllowed: false } };
    case 'rank_recipients':
      return { ...base, type, details: { duplicatesAllowed: false } };
  }
}

/** Removes undefined values so a draft compares and serialises like the stored JSON. */
export function cleanJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ak = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const bk = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Mirror of the database rule (BUILD_NOTES/01-database.md, deviation 4): a change to type, giver_type,
 * recipient_type or details (other than recommendedLength) deletes the question's responses.
 * Changes to brief, description, visibility, max_recipients and number keep them.
 */
export function changeDeletesResponses(before: QuestionDraft, after: QuestionDraft): boolean {
  if (before.type !== after.type || before.giver_type !== after.giver_type || before.recipient_type !== after.recipient_type) return true;
  const strip = (d: unknown): unknown => {
    const { recommendedLength: _r, ...rest } = (d ?? {}) as Record<string, unknown>;
    void _r;
    return rest;
  };
  return !deepEqual(strip(before.details), strip(after.details));
}
