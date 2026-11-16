import { describe, expect, it } from 'vitest';
import { ErrorCode, ERROR_MESSAGES } from './errors';
import { q, recips, subs } from './test-helpers';
import {
  LIMITS,
  answersAreValid,
  looksLikeEmail,
  normalizeEmail,
  validateAnswers,
  validateQuestion,
  validateSessionSettings,
  validateStudentFields,
} from './validation';
import { QuestionDraft, Recipient } from './types';

const codes = (question: QuestionDraft, r: Recipient[], answers: { recipient_key: string; answer: unknown }[]): ErrorCode[] =>
  validateAnswers(question, r, answers).map((e) => e.code);
const qcodes = (question: QuestionDraft): ErrorCode[] => validateQuestion(question).map((e) => e.code);

describe('error codes', () => {
  it('every error has a message', () => {
    for (const [code, msg] of Object.entries(ERROR_MESSAGES)) expect(msg.length, code).toBeGreaterThan(5);
  });
});

describe('validateQuestion', () => {
  it('accepts a valid question of every type', () => {
    const valid: QuestionDraft[] = [
      q('text', { recommendedLength: 200 }, { recipient_type: 'self' }),
      q('mcq', { choices: ['a', 'b'], otherEnabled: true }),
      q('msq', { choices: ['a', 'b', 'c'], otherEnabled: false, minSelectable: 1, maxSelectable: 2 }),
      q('numscale', { min: 1, max: 5, step: 0.5 }),
      q('constsum_options', { options: ['a', 'b'], points: 100, pointsPerOption: false, distribute: 'none', minPoint: 10, maxPoint: 90 }),
      q('constsum_recipients', { points: 100, pointsPerOption: true, distribute: 'some' }),
      q('contrib', { isZeroSum: true, isNotSureAllowed: false }, { show_responses_to: ['instructors', 'recipient', 'giver_team_members'] }),
      q('rubric', { choices: ['x', 'y'], subQuestions: ['s1'], descriptions: [['dx', 'dy']] }),
      q('rank_options', { options: ['a', 'b', 'c'], minToRank: 1, maxToRank: 3, duplicatesAllowed: false }),
      q('rank_recipients', { duplicatesAllowed: true, maxToRank: 2 }),
    ];
    for (const v of valid) expect(qcodes(v), v.type).toEqual([]);
  });

  it('requires a brief, a valid number and valid max_recipients', () => {
    expect(qcodes(q('text', {}, { brief: '  ' }))).toContain('brief_required');
    expect(qcodes(q('text', {}, { number: 0 }))).toContain('invalid_number');
    expect(qcodes(q('text', {}, { max_recipients: 0 }))).toContain('invalid_max_recipients');
  });

  it('rejects a path that the type does not allow', () => {
    expect(qcodes(q('rank_recipients', { duplicatesAllowed: false }, { recipient_type: 'none' }))).toContain('invalid_path');
    expect(qcodes(q('constsum_recipients', { points: 100, pointsPerOption: false, distribute: 'none' }, { recipient_type: 'self' }))).toContain('invalid_path');
    expect(qcodes(q('contrib', { isZeroSum: true, isNotSureAllowed: false }, { recipient_type: 'students', show_responses_to: [] }))).toContain('invalid_path');
    expect(qcodes(q('text', {}, { giver_type: 'instructors', recipient_type: 'own_team' }))).toContain('invalid_path');
  });

  it('checks visibility lists', () => {
    expect(qcodes(q('text', {}, { show_giver_name_to: ['recipient'] }))).toContain('invalid_visibility');
    expect(qcodes(q('text', {}, { show_responses_to: ['everyone' as never] }))).toContain('invalid_visibility');
    expect(
      qcodes(q('contrib', { isZeroSum: true, isNotSureAllowed: false }, { show_responses_to: ['instructors', 'recipient'], show_recipient_name_to: ['instructors'] })),
    ).toContain('contrib_visibility_pair');
  });

  it('text: recommendedLength must be a whole number of at least 1', () => {
    expect(qcodes(q('text', { recommendedLength: 0 }))).toContain('invalid_recommended_length');
    expect(qcodes(q('text', { recommendedLength: 1.5 }))).toContain('invalid_recommended_length');
  });

  it('mcq and msq: choices need two, non-blank, unique values', () => {
    expect(qcodes(q('mcq', { choices: ['a'], otherEnabled: false }))).toContain('too_few_choices');
    expect(qcodes(q('mcq', { choices: ['a', ' '], otherEnabled: false }))).toContain('empty_choice');
    expect(qcodes(q('mcq', { choices: ['a', 'a '], otherEnabled: false }))).toContain('duplicate_option');
    expect(qcodes(q('msq', { choices: ['a', 'b'], otherEnabled: false, maxSelectable: 3 }))).toContain('invalid_selectable_limits');
    expect(qcodes(q('msq', { choices: ['a', 'b', 'c'], otherEnabled: false, minSelectable: 3, maxSelectable: 2 }))).toContain('invalid_selectable_limits');
    expect(qcodes(q('msq', { choices: ['a', 'b'], otherEnabled: false, maxSelectable: 1 }))).toContain('invalid_selectable_limits');
  });

  it('numscale: min below max and step above 0', () => {
    expect(qcodes(q('numscale', { min: 5, max: 5, step: 1 }))).toContain('invalid_scale');
    expect(qcodes(q('numscale', { min: 1, max: 5, step: 0 }))).toContain('invalid_scale');
  });

  it('constsum: points, distribution and bounds', () => {
    const base = { options: ['a', 'b'], points: 100, pointsPerOption: false, distribute: 'none' as const };
    expect(qcodes(q('constsum_options', { ...base, points: 0 }))).toContain('invalid_points');
    expect(qcodes(q('constsum_options', { ...base, distribute: 'weird' as never }))).toContain('invalid_distribute');
    expect(qcodes(q('constsum_options', { ...base, options: ['a'] }))).toContain('too_few_choices');
    expect(qcodes(q('constsum_options', { ...base, minPoint: 60 }))).toContain('invalid_min_max_point');
    expect(qcodes(q('constsum_options', { ...base, maxPoint: 40 }))).toContain('invalid_min_max_point');
    expect(qcodes(q('constsum_recipients', { points: 100, pointsPerOption: false, distribute: 'none', minPoint: 20, maxPoint: 10 }))).toContain('invalid_min_max_point');
  });

  it('contrib: zero-sum and not-sure conflict; no max_recipients', () => {
    expect(qcodes(q('contrib', { isZeroSum: true, isNotSureAllowed: true }, { show_responses_to: [] }))).toContain('contrib_conflict');
    expect(qcodes(q('contrib', { isZeroSum: false, isNotSureAllowed: true }, { show_responses_to: [], max_recipients: 2 }))).toContain('invalid_max_recipients');
  });

  it('rubric: grid must match, two choices, one non-blank sub-question', () => {
    expect(qcodes(q('rubric', { choices: ['x'], subQuestions: ['s'], descriptions: [['d']] }))).toContain('invalid_rubric');
    expect(qcodes(q('rubric', { choices: ['x', 'y'], subQuestions: [], descriptions: [] }))).toContain('invalid_rubric');
    expect(qcodes(q('rubric', { choices: ['x', 'y'], subQuestions: ['s', ' '], descriptions: [['a', 'b'], ['a', 'b']] }))).toContain('invalid_rubric');
    expect(qcodes(q('rubric', { choices: ['x', 'y'], subQuestions: ['s'], descriptions: [['a']] }))).toContain('invalid_rubric');
    // blank choices are allowed
    expect(qcodes(q('rubric', { choices: ['', 'y'], subQuestions: ['s'], descriptions: [['a', 'b']] }))).toEqual([]);
  });

  it('rank: limits within the number of options, min not above max', () => {
    expect(qcodes(q('rank_options', { options: ['a', 'b'], duplicatesAllowed: false, maxToRank: 3 }))).toContain('invalid_rank_limits');
    expect(qcodes(q('rank_options', { options: ['a', 'b'], duplicatesAllowed: false, minToRank: 2, maxToRank: 1 }))).toContain('invalid_rank_limits');
    expect(qcodes(q('rank_recipients', { duplicatesAllowed: false, minToRank: 0 }))).toContain('invalid_rank_limits');
  });
});

describe('validateAnswers: shared rules', () => {
  const text = q('text', {});
  it('an empty list is valid (delete my answers)', () => {
    expect(codes(text, recips(2), [])).toEqual([]);
  });
  it('rejects recipients outside the resolved list, duplicates and too many', () => {
    expect(codes(text, recips(1), [{ recipient_key: 'zzz', answer: { text: 'x' } }])).toEqual(['not_a_recipient']);
    expect(codes(text, recips(2), [...subs({ text: 'a' }), { recipient_key: 'r1', answer: { text: 'b' } }])).toContain('duplicate_recipient');
    const capped = q('text', {}, { max_recipients: 1 });
    expect(codes(capped, recips(3), subs({ text: 'a' }, { text: 'b' }))).toContain('too_many_recipients');
    expect(codes(capped, recips(3), subs({ text: 'a' }))).toEqual([]);
  });
  it('rejects a non-string giver_comment', () => {
    expect(validateAnswers(text, recips(1), [{ recipient_key: 'r1', answer: { text: 'x' }, giver_comment: 5 as never }]).map((e) => e.code)).toEqual(['invalid_input']);
  });
  it('tags errors with the recipient key', () => {
    const [e] = validateAnswers(text, recips(2), subs({ text: 'ok' }, { text: ' ' }));
    expect(e.recipient_key).toBe('r2');
    expect(e.message).toBe(ERROR_MESSAGES.empty_text);
  });
});

describe('validateAnswers: text', () => {
  it('valid and invalid', () => {
    const t = q('text', {});
    expect(answersAreValid(t, recips(1), subs({ text: 'hello' }))).toBe(true);
    expect(codes(t, recips(1), subs({ text: '  ' }))).toEqual(['empty_text']);
    expect(codes(t, recips(1), subs({ nope: 1 }))).toEqual(['invalid_answer']);
    expect(codes(t, recips(1), subs('plain string'))).toEqual(['invalid_answer']);
  });
});

describe('validateAnswers: mcq', () => {
  const m = q('mcq', { choices: ['a', 'b'], otherEnabled: true });
  const noOther = q('mcq', { choices: ['a', 'b'], otherEnabled: false });
  it('valid', () => {
    expect(codes(m, recips(1), subs({ choice: 'a' }))).toEqual([]);
    expect(codes(m, recips(1), subs({ other: 'something' }))).toEqual([]);
  });
  it('invalid', () => {
    expect(codes(m, recips(1), subs({ choice: 'c' }))).toEqual(['not_a_choice']);
    expect(codes(m, recips(1), subs({ other: ' ' }))).toEqual(['empty_other']);
    expect(codes(noOther, recips(1), subs({ other: 'x' }))).toEqual(['other_not_allowed']);
    expect(codes(m, recips(1), subs({ choice: 'a', other: 'x' }))).toEqual(['invalid_answer']);
    expect(codes(m, recips(1), subs({}))).toEqual(['invalid_answer']);
  });
});

describe('validateAnswers: msq', () => {
  const m = q('msq', { choices: ['a', 'b', 'c'], otherEnabled: true, minSelectable: 2, maxSelectable: 2 });
  it('valid, including none of the above', () => {
    expect(codes(m, recips(1), subs({ choices: ['a', 'b'] }))).toEqual([]);
    expect(codes(m, recips(1), subs({ choices: ['a'], other: 'x' }))).toEqual([]);
    expect(codes(m, recips(1), subs({ choices: [] }))).toEqual([]);
  });
  it('invalid', () => {
    expect(codes(m, recips(1), subs({ choices: ['a'] }))).toEqual(['too_few_selected']);
    expect(codes(m, recips(1), subs({ choices: ['a', 'b', 'c'] }))).toEqual(['too_many_selected']);
    expect(codes(m, recips(1), subs({ choices: ['a', 'z'] }))).toContain('not_a_choice');
    expect(codes(m, recips(1), subs({ choices: ['a', 'a'] }))).toContain('duplicate_choice');
    expect(codes(m, recips(1), subs({ choices: ['a'], other: ' ' }))).toContain('empty_other');
    expect(codes(q('msq', { choices: ['a', 'b'], otherEnabled: false }), recips(1), subs({ choices: [], other: 'x' }))).toContain('other_not_allowed');
    expect(codes(m, recips(1), subs({ choices: 'a' }))).toEqual(['invalid_answer']);
  });
});

describe('validateAnswers: numscale', () => {
  const n = q('numscale', { min: 1, max: 5, step: 0.5 });
  it('valid', () => {
    for (const v of [1, 2.5, 5]) expect(codes(n, recips(1), subs({ value: v }))).toEqual([]);
    expect(codes(q('numscale', { min: 0, max: 1, step: 0.1 }), recips(1), subs({ value: 0.3 }))).toEqual([]);
  });
  it('invalid', () => {
    expect(codes(n, recips(1), subs({ value: 0.5 }))).toEqual(['out_of_range']);
    expect(codes(n, recips(1), subs({ value: 5.5 }))).toEqual(['out_of_range']);
    expect(codes(n, recips(1), subs({ value: 2.2 }))).toEqual(['not_on_step']);
    expect(codes(n, recips(1), subs({ value: '3' }))).toEqual(['invalid_answer']);
    expect(codes(n, recips(1), subs({ value: NaN }))).toEqual(['invalid_answer']);
  });
});

describe('validateAnswers: constsum_options', () => {
  const base = { options: ['a', 'b', 'c'], points: 100, pointsPerOption: false, distribute: 'none' as const };
  it('valid', () => {
    expect(codes(q('constsum_options', base), recips(1), subs({ points: [50, 30, 20] }))).toEqual([]);
    expect(codes(q('constsum_options', { ...base, pointsPerOption: true }), recips(1), subs({ points: [100, 100, 100] }))).toEqual([]);
  });
  it('invalid', () => {
    const c = q('constsum_options', base);
    expect(codes(c, recips(1), subs({ points: [50, 30, 10] }))).toEqual(['sum_mismatch']);
    expect(codes(c, recips(1), subs({ points: [110, -10, 0] }))).toEqual(['negative_points']);
    expect(codes(c, recips(1), subs({ points: [50, 50] }))).toEqual(['wrong_option_count']);
    expect(codes(c, recips(1), subs({ points: [50.5, 49.5, 0] }))).toEqual(['invalid_answer']);
    expect(codes(q('constsum_options', { ...base, minPoint: 10 }), recips(1), subs({ points: [90, 10, 0] }))).toEqual(['below_min_point']);
    expect(codes(q('constsum_options', { ...base, maxPoint: 50 }), recips(1), subs({ points: [60, 20, 20] }))).toEqual(['above_max_point']);
    expect(codes(q('constsum_options', { ...base, distribute: 'some' }), recips(1), subs({ points: [50, 50, 0] }))).toEqual([]);
    expect(codes(q('constsum_options', { ...base, distribute: 'some', points: 90 }), recips(1), subs({ points: [30, 30, 30] }))).toEqual(['not_enough_distinct']);
    expect(codes(q('constsum_options', { ...base, distribute: 'all' }), recips(1), subs({ points: [50, 50, 0] }))).toEqual(['not_all_distinct']);
    expect(codes(q('constsum_options', { ...base, distribute: 'all' }), recips(1), subs({ points: [50, 30, 20] }))).toEqual([]);
  });
});

describe('validateAnswers: constsum_recipients', () => {
  const pooled = q('constsum_recipients', { points: 100, pointsPerOption: false, distribute: 'none' });
  const perRecipient = q('constsum_recipients', { points: 100, pointsPerOption: true, distribute: 'none' });
  it('valid: the pool is shared across rows', () => {
    expect(codes(pooled, recips(3), subs({ points: 50 }, { points: 30 }, { points: 20 }))).toEqual([]);
    expect(codes(perRecipient, recips(3), subs({ points: 110 }, { points: 100 }, { points: 90 }))).toEqual([]);
  });
  it('total follows the number of rows answered when pointsPerOption', () => {
    expect(codes(perRecipient, recips(3), subs({ points: 100 }, { points: 100 }))).toEqual([]);
  });
  it('invalid', () => {
    expect(codes(pooled, recips(2), subs({ points: 50 }, { points: 40 }))).toEqual(['sum_mismatch']);
    expect(codes(pooled, recips(2), subs({ points: 120 }, { points: -20 }))).toEqual(['negative_points']);
    expect(codes(pooled, recips(2), subs({ points: 'x' }, { points: 50 }))).toEqual(['invalid_answer']);
    expect(codes(q('constsum_recipients', { points: 90, pointsPerOption: false, distribute: 'all' }), recips(3), subs({ points: 30 }, { points: 30 }, { points: 30 }))).toEqual(['not_all_distinct']);
  });
});

describe('validateAnswers: contrib', () => {
  const zero = q('contrib', { isZeroSum: true, isNotSureAllowed: false }, { show_responses_to: [] });
  const open = q('contrib', { isZeroSum: false, isNotSureAllowed: true }, { show_responses_to: [] });
  it('valid', () => {
    expect(codes(zero, recips(3), subs({ value: 100 }, { value: 110 }, { value: 90 }))).toEqual([]);
    expect(codes(open, recips(3), subs({ value: 100 }, { value: -101 }))).toEqual([]);
    expect(codes(open, recips(3), subs({ value: 0 }, { value: 200 }, { value: 5 }))).toEqual([]);
  });
  it('invalid', () => {
    expect(codes(zero, recips(3), subs({ value: 100 }, { value: 100 }, { value: 95 }))).toEqual(['sum_mismatch']);
    expect(codes(zero, recips(3), subs({ value: 100 }, { value: 100 }))).toEqual(['contrib_all_required']);
    expect(codes(zero, recips(2), subs({ value: -101 }, { value: 100 }))).toContain('invalid_contrib_value');
    expect(codes(open, recips(2), subs({ value: 205 }, { value: 100 }))).toEqual(['out_of_range']);
    expect(codes(open, recips(2), subs({ value: 101 }, { value: 100 }))).toEqual(['not_on_step']);
    expect(codes(open, recips(2), subs({ value: 'x' }, { value: 100 }))).toEqual(['invalid_answer']);
  });
});

describe('validateAnswers: rubric', () => {
  const r = q('rubric', { choices: ['x', 'y', 'z'], subQuestions: ['s1', 's2'], descriptions: [['', '', ''], ['', '', '']] });
  it('valid', () => {
    expect(codes(r, recips(1), subs({ choices: [0, 2] }))).toEqual([]);
    expect(codes(r, recips(1), subs({ choices: [-1, 1] }))).toEqual([]);
  });
  it('invalid', () => {
    expect(codes(r, recips(1), subs({ choices: [-1, -1] }))).toEqual(['no_rubric_answer']);
    expect(codes(r, recips(1), subs({ choices: [3, 0] }))).toEqual(['invalid_rubric_choice']);
    expect(codes(r, recips(1), subs({ choices: [0] }))).toEqual(['invalid_answer']);
    expect(codes(r, recips(1), subs({ choices: [0.5, 1] }))).toEqual(['invalid_rubric_choice']);
  });
});

describe('validateAnswers: rank_options', () => {
  const r = q('rank_options', { options: ['a', 'b', 'c'], duplicatesAllowed: false, minToRank: 2, maxToRank: 3 });
  it('valid', () => {
    expect(codes(r, recips(1), subs({ ranks: [1, 2, 3] }))).toEqual([]);
    expect(codes(r, recips(1), subs({ ranks: [2, null, 1] }))).toEqual([]);
    expect(codes(q('rank_options', { options: ['a', 'b'], duplicatesAllowed: true }), recips(1), subs({ ranks: [1, 1] }))).toEqual([]);
  });
  it('invalid', () => {
    expect(codes(r, recips(1), subs({ ranks: [1, 1, 2] }))).toEqual(['duplicate_rank']);
    expect(codes(r, recips(1), subs({ ranks: [1, null, null] }))).toEqual(['too_few_ranked']);
    expect(codes(r, recips(1), subs({ ranks: [null, null, null] }))).toEqual(['too_few_ranked']);
    expect(codes(r, recips(1), subs({ ranks: [1, 2, 4] }))).toEqual(['rank_out_of_range']);
    expect(codes(r, recips(1), subs({ ranks: [1, 2] }))).toEqual(['invalid_answer']);
    expect(codes(q('rank_options', { options: ['a', 'b', 'c'], duplicatesAllowed: false, maxToRank: 1 }), recips(1), subs({ ranks: [1, 2, null] }))).toEqual(['too_many_ranked']);
  });
});

describe('validateAnswers: rank_recipients', () => {
  const r = q('rank_recipients', { duplicatesAllowed: false });
  it('valid', () => {
    expect(codes(r, recips(3), subs({ rank: 2 }, { rank: 1 }, { rank: 3 }))).toEqual([]);
    expect(codes(q('rank_recipients', { duplicatesAllowed: true }), recips(2), subs({ rank: 1 }, { rank: 1 }))).toEqual([]);
  });
  it('invalid', () => {
    expect(codes(r, recips(3), subs({ rank: 1 }, { rank: 1 }, { rank: 2 }))).toEqual(['duplicate_rank']);
    expect(codes(r, recips(3), subs({ rank: 0 }, { rank: 2 }, { rank: 3 }))).toEqual(['rank_out_of_range']);
    expect(codes(r, recips(3), subs({ rank: 4 }, { rank: 2 }, { rank: 3 }))).toEqual(['rank_out_of_range']);
    expect(codes(r, recips(3), subs({ rank: 'a' }, { rank: 2 }))).toEqual(['invalid_answer']);
    expect(codes(q('rank_recipients', { duplicatesAllowed: false, minToRank: 3 }), recips(3), subs({ rank: 1 }, { rank: 2 }))).toEqual(['too_few_ranked']);
    expect(codes(q('rank_recipients', { duplicatesAllowed: false, maxToRank: 1 }), recips(3), subs({ rank: 1 }, { rank: 2 }))).toEqual(['too_many_ranked']);
  });
  it('rank upper bound follows max_recipients', () => {
    const capped = q('rank_recipients', { duplicatesAllowed: false }, { max_recipients: 2 });
    expect(codes(capped, recips(5), subs({ rank: 1 }, { rank: 3 }))).toEqual(['rank_out_of_range']);
  });
});

describe('roster field validation', () => {
  const ok = { section: 'S1', team: 'T1', name: 'Ann', email: 'ann@x.edu', comments: '' };
  const codesOf = (over: Partial<typeof ok>) => validateStudentFields({ ...ok, ...over }).map((e) => `${e.code}:${e.field}`);
  it('accepts a normal row', () => {
    expect(codesOf({})).toEqual([]);
  });
  it('checks required fields, length limits and forbidden characters', () => {
    expect(codesOf({ name: '' })).toContain('required_field_missing:name');
    expect(codesOf({ name: 'x'.repeat(LIMITS.name + 1) })).toContain('too_long:name');
    expect(codesOf({ name: 'x'.repeat(LIMITS.name) })).toEqual([]);
    expect(codesOf({ team: 'x'.repeat(LIMITS.team + 1) })).toContain('too_long:team');
    expect(codesOf({ section: 'x'.repeat(LIMITS.section + 1) })).toContain('too_long:section');
    expect(codesOf({ comments: 'x'.repeat(LIMITS.comments + 1) })).toContain('too_long:comments');
    expect(codesOf({ name: 'A|B' })).toContain('forbidden_char:name');
    expect(codesOf({ team: '50%' })).toContain('forbidden_char:team');
    expect(codesOf({ email: 'a'.repeat(250) + '@x.com' })).toContain('too_long:email');
  });
  it('checks email shape and team names that look like emails', () => {
    expect(codesOf({ email: 'not-an-email' })).toContain('invalid_email:email');
    expect(codesOf({ team: 'a@b.com' })).toContain('team_looks_like_email:team');
    expect(looksLikeEmail(' a@b.co ')).toBe(true);
    expect(normalizeEmail('  A@B.Co ')).toBe('a@b.co');
  });
});

describe('validateSessionSettings', () => {
  const ok = {
    name: 'Peer eval 1',
    opens_at: '2026-10-01T06:00:00Z',
    closes_at: '2026-10-08T05:59:00Z',
    grace_minutes: 15,
    results_visibility: 'later',
    results_visible_at: null,
  };
  const c = (over: object) => validateSessionSettings({ ...ok, ...over }).map((e) => e.code);
  it('accepts valid settings', () => expect(c({})).toEqual([]));
  it('rejects bad times, grace, names and custom publish time', () => {
    expect(c({ closes_at: ok.opens_at })).toContain('invalid_time_range');
    expect(c({ grace_minutes: 7 })).toContain('invalid_grace');
    expect(c({ grace_minutes: 35 })).toContain('invalid_grace');
    expect(c({ name: 'a|b' })).toContain('forbidden_char');
    expect(c({ name: 'x'.repeat(65) })).toContain('too_long');
    expect(c({ name: '' })).toContain('required_field_missing');
    expect(c({ results_visibility: 'custom' })).toContain('invalid_time_range');
    expect(c({ results_visibility: 'custom', results_visible_at: '2026-10-09T00:00:00Z' })).toEqual([]);
    expect(c({ results_visibility: 'whenever' })).toContain('invalid_input');
  });
});

describe('answer size limits (same as SQL)', () => {
  const t = q('text', {});
  it('accepts 10000 characters and rejects 10001', () => {
    expect(codes(t, recips(1), subs({ text: 'x'.repeat(10000) }))).toEqual([]);
    expect(codes(t, recips(1), subs({ text: 'x'.repeat(10001) }))).toEqual(['too_long']);
  });
  it('limits giver_comment to 2000 characters', () => {
    const one = (c: string) => [{ ...subs({ text: 'x' })[0], giver_comment: c }];
    expect(codes(t, recips(1), one('y'.repeat(2000)))).toEqual([]);
    expect(codes(t, recips(1), one('y'.repeat(2001)))).toEqual(['too_long']);
  });
});
