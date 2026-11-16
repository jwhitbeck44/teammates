import { describe, expect, it } from 'vitest';
import {
  AnswerInput,
  CONTRIB_NOT_SURE_VALUE,
  constsumRules,
  constsumTarget,
  contribOptions,
  contribTarget,
  contribTotal,
  emptyInput,
  inputFromAnswer,
  inputToAnswer,
  msqRules,
  rankChoices,
  rankRules,
  sumPoints,
  toggleMsqChoice,
} from './mapping';
import { validateAnswers } from '../../lib/validation';
import { q, recips } from '../../lib/test-helpers';
import type { QuestionType } from '../../lib/types';

// Round trip helper: answer -> input -> answer must give the same JSON.
function roundTrip(type: QuestionType, details: unknown, answer: unknown) {
  const input = inputFromAnswer(type, details as never, answer);
  return inputToAnswer(type, details as never, input);
}

const mcq = { choices: ['A', 'B'], otherEnabled: true };
const msq = { choices: ['A', 'B', 'C'], otherEnabled: true };
const cs = { options: ['x', 'y', 'z'], points: 100, pointsPerOption: false, distribute: 'none' as const };
const rubric = { choices: ['Low', 'High'], subQuestions: ['s1', 's2', 's3'], descriptions: [['', ''], ['', ''], ['', '']] };
const rankOpt = { options: ['p', 'q', 'r'], duplicatesAllowed: false };

describe('text', () => {
  it('maps text and drops blanks', () => {
    expect(inputToAnswer('text', {}, { type: 'text', text: '  hello  ' })).toEqual({ text: 'hello' });
    expect(inputToAnswer('text', {}, { type: 'text', text: '   ' })).toBeNull();
    expect(roundTrip('text', {}, { text: 'hi' })).toEqual({ text: 'hi' });
  });
});

describe('mcq', () => {
  it('maps a choice, an other, and blank', () => {
    expect(inputToAnswer('mcq', mcq, { type: 'mcq', choice: 'B', otherSelected: false, other: '' })).toEqual({ choice: 'B' });
    expect(inputToAnswer('mcq', mcq, { type: 'mcq', choice: null, otherSelected: true, other: ' Z ' })).toEqual({ other: 'Z' });
    expect(inputToAnswer('mcq', mcq, emptyInput('mcq', mcq))).toBeNull();
  });
  it('sends an empty other so validation can reject it', () => {
    const a = inputToAnswer('mcq', mcq, { type: 'mcq', choice: null, otherSelected: true, other: '' });
    expect(a).toEqual({ other: '' });
    const errs = validateAnswers(q('mcq', mcq), recips(1), [{ recipient_key: 'r1', answer: a }]);
    expect(errs.map((e) => e.code)).toEqual(['empty_other']);
  });
  it('round trips', () => {
    expect(roundTrip('mcq', mcq, { choice: 'A' })).toEqual({ choice: 'A' });
    expect(roundTrip('mcq', mcq, { other: 'Z' })).toEqual({ other: 'Z' });
  });
});

describe('msq', () => {
  it('orders picks like the question, adds other, and handles none of the above', () => {
    const input: AnswerInput = { type: 'msq', choices: ['C', 'A'], otherChecked: true, other: 'Q', none: false };
    expect(inputToAnswer('msq', msq, input)).toEqual({ choices: ['A', 'C'], other: 'Q' });
    expect(inputToAnswer('msq', msq, { type: 'msq', choices: [], otherChecked: false, other: '', none: true })).toEqual({ choices: [] });
    expect(inputToAnswer('msq', msq, emptyInput('msq', msq))).toBeNull();
  });
  it('round trips including none of the above', () => {
    expect(roundTrip('msq', msq, { choices: ['A', 'B'] })).toEqual({ choices: ['A', 'B'] });
    expect(roundTrip('msq', msq, { choices: [] })).toEqual({ choices: [] });
    expect(roundTrip('msq', msq, { choices: ['B'], other: 'x' })).toEqual({ choices: ['B'], other: 'x' });
  });
  it('picking a choice clears none of the above', () => {
    const none = inputFromAnswer('msq', msq as never, { choices: [] }) as Extract<AnswerInput, { type: 'msq' }>;
    expect(none.none).toBe(true);
    expect(toggleMsqChoice(none, 'A', true)).toMatchObject({ choices: ['A'], none: false });
  });
  it('describes selection limits', () => {
    expect(msqRules({ minSelectable: 1, maxSelectable: 2 })).toEqual(['Pick 1 to 2.']);
    expect(msqRules({ minSelectable: 2, maxSelectable: 2 })).toEqual(['Pick 2.']);
    expect(msqRules({})).toEqual([]);
  });
});

describe('numscale', () => {
  const d = { min: 1, max: 5, step: 0.5 };
  it('maps numbers, blanks and junk', () => {
    expect(inputToAnswer('numscale', d, { type: 'numscale', value: '3.5' })).toEqual({ value: 3.5 });
    expect(inputToAnswer('numscale', d, { type: 'numscale', value: '' })).toBeNull();
    const junk = inputToAnswer('numscale', d, { type: 'numscale', value: 'abc' }) as { value: number };
    expect(Number.isNaN(junk.value)).toBe(true);
    const errs = validateAnswers(q('numscale', d), recips(1), [{ recipient_key: 'r1', answer: junk }]);
    expect(errs[0].code).toBe('invalid_answer');
  });
  it('round trips', () => {
    expect(roundTrip('numscale', d, { value: 4.5 })).toEqual({ value: 4.5 });
  });
});

describe('constsum_options', () => {
  it('turns blanks into zero when something is filled', () => {
    expect(inputToAnswer('constsum_options', cs, { type: 'constsum_options', points: ['60', '', '40'] })).toEqual({ points: [60, 0, 40] });
  });
  it('treats an untouched row as no answer', () => {
    expect(inputToAnswer('constsum_options', cs, emptyInput('constsum_options', cs))).toBeNull();
  });
  it('round trips and checks the total', () => {
    expect(roundTrip('constsum_options', cs, { points: [50, 30, 20] })).toEqual({ points: [50, 30, 20] });
    expect(sumPoints(['50', '', 'x', '20'])).toBe(70);
    expect(constsumTarget({ points: 100, pointsPerOption: false }, 3)).toBe(100);
    expect(constsumTarget({ points: 10, pointsPerOption: true }, 3)).toBe(30);
  });
  it('lists plain rules', () => {
    expect(constsumRules({ distribute: 'all', minPoint: 5 })).toEqual(['At least 5 each.', 'Every number must be different.']);
    expect(constsumRules({ distribute: 'none' })).toEqual([]);
  });
});

describe('constsum_recipients', () => {
  const d = { points: 100, pointsPerOption: false, distribute: 'none' as const };
  it('maps and round trips', () => {
    expect(inputToAnswer('constsum_recipients', d, { type: 'constsum_recipients', points: '25' })).toEqual({ points: 25 });
    expect(inputToAnswer('constsum_recipients', d, { type: 'constsum_recipients', points: '' })).toBeNull();
    expect(roundTrip('constsum_recipients', d, { points: 0 })).toEqual({ points: 0 });
  });
});

describe('contrib', () => {
  it('offers 0..200 step 5 in Equal share wording, with Not sure only when allowed', () => {
    const o = contribOptions(false);
    expect(o).toHaveLength(41);
    expect(o[0]).toEqual({ value: '0', label: '0%' });
    expect(o.find((x) => x.value === '100')?.label).toBe('Equal share');
    expect(o.find((x) => x.value === '110')?.label).toBe('Equal share + 10%');
    expect(o.find((x) => x.value === '90')?.label).toBe('Equal share - 10%');
    expect(o.at(-1)?.value).toBe('200');
    const ns = contribOptions(true);
    expect(ns.at(-1)).toEqual({ value: CONTRIB_NOT_SURE_VALUE, label: 'Not sure' });
  });
  it('maps values, not sure and blank', () => {
    const d = { isZeroSum: false, isNotSureAllowed: true };
    expect(inputToAnswer('contrib', d, { type: 'contrib', value: '110' })).toEqual({ value: 110 });
    expect(inputToAnswer('contrib', d, { type: 'contrib', value: CONTRIB_NOT_SURE_VALUE })).toEqual({ value: -101 });
    expect(inputToAnswer('contrib', d, { type: 'contrib', value: '0' })).toEqual({ value: 0 });
    expect(inputToAnswer('contrib', d, { type: 'contrib', value: '' })).toBeNull();
  });
  it('round trips not sure', () => {
    const d = { isZeroSum: false, isNotSureAllowed: true };
    expect(roundTrip('contrib', d, { value: -101 })).toEqual({ value: -101 });
    expect(inputFromAnswer('contrib', d, { value: -101 })).toEqual({ type: 'contrib', value: 'ns' });
  });
  it('totals and targets for zero-sum', () => {
    expect(contribTotal(['100', '110', '', 'ns', '90'])).toBe(300);
    expect(contribTarget(3)).toBe(300);
  });
});

describe('rubric', () => {
  it('starts unanswered, maps picks, drops an all-blank row', () => {
    expect(emptyInput('rubric', rubric)).toEqual({ type: 'rubric', choices: [-1, -1, -1] });
    expect(inputToAnswer('rubric', rubric, emptyInput('rubric', rubric))).toBeNull();
    expect(inputToAnswer('rubric', rubric, { type: 'rubric', choices: [1, -1, 0] })).toEqual({ choices: [1, -1, 0] });
    expect(roundTrip('rubric', rubric, { choices: [0, 1, -1] })).toEqual({ choices: [0, 1, -1] });
  });
});

describe('rank_options', () => {
  it('maps ranks with null for unranked and blanks to null', () => {
    expect(inputToAnswer('rank_options', rankOpt, { type: 'rank_options', ranks: ['2', '', '1'] })).toEqual({ ranks: [2, null, 1] });
    expect(inputToAnswer('rank_options', rankOpt, emptyInput('rank_options', rankOpt))).toBeNull();
    expect(roundTrip('rank_options', rankOpt, { ranks: [null, 1, 2] })).toEqual({ ranks: [null, 1, 2] });
  });
  it('offers ranks 1..n and plain rules', () => {
    expect(rankChoices(3)).toEqual(['1', '2', '3']);
    expect(rankChoices(0)).toEqual([]);
    expect(rankRules({ minToRank: 2, duplicatesAllowed: false })).toEqual(['Rank at least 2.', 'Use each rank once.']);
    expect(rankRules({ duplicatesAllowed: true })).toEqual(['Ties are allowed.']);
  });
});

describe('rank_recipients', () => {
  it('maps and round trips', () => {
    const d = { duplicatesAllowed: false };
    expect(inputToAnswer('rank_recipients', d, { type: 'rank_recipients', rank: '2' })).toEqual({ rank: 2 });
    expect(inputToAnswer('rank_recipients', d, { type: 'rank_recipients', rank: '' })).toBeNull();
    expect(roundTrip('rank_recipients', d, { rank: 1 })).toEqual({ rank: 1 });
  });
});

describe('malformed saved answers', () => {
  it('give blank inputs instead of throwing', () => {
    for (const bad of [null, 'x', 5, [], { nope: true }]) {
      expect(inputToAnswer('text', {}, inputFromAnswer('text', {}, bad))).toBeNull();
      expect(inputToAnswer('constsum_options', cs, inputFromAnswer('constsum_options', cs, bad))).toBeNull();
      expect(inputToAnswer('rubric', rubric, inputFromAnswer('rubric', rubric, bad))).toBeNull();
    }
  });
  it('a mismatched input type gives null', () => {
    expect(inputToAnswer('text', {}, { type: 'contrib', value: '100' })).toBeNull();
  });
});
