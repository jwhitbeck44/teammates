import { describe, expect, it } from 'vitest';
import { changeDeletesResponses, cleanJson, defaultDraft } from './draft';
import { QUESTION_TYPES, type QuestionDraft } from '../../../lib/types';
import { isAllowedPath } from '../../../lib/recipients';
import { validateQuestion } from '../../../lib/validation';

describe('defaultDraft', () => {
  it('uses an allowed path for every type', () => {
    for (const t of QUESTION_TYPES) {
      const d = defaultDraft(t, 3);
      expect(d.number).toBe(3);
      expect(isAllowedPath(d.giver_type, d.recipient_type, t)).toBe(true);
    }
  });
});

describe('defaultDraft validity', () => {
  it('passes validateQuestion once the question text is filled in', () => {
    for (const t of QUESTION_TYPES) {
      const d = { ...defaultDraft(t, 1), brief: 'Question' } as QuestionDraft;
      expect(validateQuestion(d), t).toEqual([]);
    }
  });
});

describe('changeDeletesResponses', () => {
  const base = defaultDraft('mcq', 1) as QuestionDraft;
  it('keeps responses when only text, visibility or limits change', () => {
    expect(changeDeletesResponses(base, { ...base, brief: 'new', description: 'd', max_recipients: 2, show_responses_to: ['recipient', 'instructors'] })).toBe(false);
  });
  it('deletes when choices, type or path change', () => {
    expect(changeDeletesResponses(base, { ...base, details: { choices: ['a', 'b', 'c'], otherEnabled: false } } as QuestionDraft)).toBe(true);
    expect(changeDeletesResponses(base, { ...base, recipient_type: 'self' })).toBe(true);
    expect(changeDeletesResponses(base, { ...base, giver_type: 'instructors' })).toBe(true);
    expect(changeDeletesResponses(base, defaultDraft('text', 1))).toBe(true);
  });
  it('ignores recommendedLength and key order', () => {
    const t = defaultDraft('text', 1);
    expect(changeDeletesResponses(t, { ...t, details: { recommendedLength: 200 } } as QuestionDraft)).toBe(false);
    const n = defaultDraft('numscale', 1);
    const reordered = { ...n, details: { step: 1, max: 5, min: 1 } } as QuestionDraft;
    expect(changeDeletesResponses(n, reordered)).toBe(false);
  });
  it('treats an undefined optional field like a missing one', () => {
    const c = defaultDraft('constsum_recipients', 1);
    const withUndefined = { ...c, details: { ...c.details, minPoint: undefined } } as QuestionDraft;
    expect(changeDeletesResponses(c, withUndefined)).toBe(false);
    expect(cleanJson(withUndefined.details)).toEqual(c.details);
  });
});
