import { describe, expect, it } from 'vitest';
import type { PayloadQuestion } from '../../lib/studentTypes';
import {
  activeRecipients,
  asValidationQuestion,
  buildSubmission,
  initState,
  isCapped,
  isSelfRecipient,
  rankLimit,
  signature,
  toggleChosen,
} from './draft';
import { validateAnswers } from '../../lib/validation';

const recipients = [
  { recipient_key: 's:1', display_name: 'Ann', team_key: 't:A|T1' },
  { recipient_key: 's:2', display_name: 'Bo', team_key: 't:A|T1' },
  { recipient_key: 's:3', display_name: 'Cy', team_key: 't:A|T1' },
];

function question(over: Partial<PayloadQuestion> & { type: PayloadQuestion['type']; details: unknown }): PayloadQuestion {
  return {
    id: 'q1',
    number: 1,
    brief: 'B',
    description: '',
    giver_type: 'students',
    recipient_type: 'own_team_members_including_self',
    max_recipients: null,
    recipients,
    answers: [],
    ...over,
  } as PayloadQuestion;
}

describe('contrib draft', () => {
  const q = question({ type: 'contrib', details: { isZeroSum: true, isNotSureAllowed: false } });
  it('starts blank and sends nothing', () => {
    const st = initState(q);
    expect(buildSubmission(q, st)).toEqual([]);
    expect(signature(q, st)).toBe('[]');
  });
  it('builds one row per answered member and validates the zero-sum rule', () => {
    const st = initState(q);
    st.inputs['s:1'] = { type: 'contrib', value: '110' };
    st.inputs['s:2'] = { type: 'contrib', value: '100' };
    st.inputs['s:3'] = { type: 'contrib', value: '90' };
    const sub = buildSubmission(q, st);
    expect(sub).toEqual([
      { recipient_key: 's:1', answer: { value: 110 } },
      { recipient_key: 's:2', answer: { value: 100 } },
      { recipient_key: 's:3', answer: { value: 90 } },
    ]);
    expect(validateAnswers(asValidationQuestion(q), q.recipients, sub)).toEqual([]);
    st.inputs['s:3'] = { type: 'contrib', value: '' };
    const partial = buildSubmission(q, st);
    expect(validateAnswers(asValidationQuestion(q), q.recipients, partial).map((e) => e.code)).toEqual(['contrib_all_required']);
  });
});

describe('saved answers', () => {
  const q = question({
    type: 'text',
    details: {},
    recipient_type: 'own_team_members',
    answers: [{ recipient_key: 's:2', answer: { text: 'Great' }, giver_comment: 'c' }],
  });
  it('load into state, keep the comment, and are not dirty until changed', () => {
    const st = initState(q);
    const saved = signature(q, st);
    expect(buildSubmission(q, st)).toEqual([{ recipient_key: 's:2', answer: { text: 'Great' }, giver_comment: 'c' }]);
    st.inputs['s:2'] = { type: 'text', text: 'Great!' };
    expect(signature(q, st)).not.toBe(saved);
  });
  it('clearing everything gives an empty submission, which deletes the rows', () => {
    const st = initState(q);
    st.inputs['s:2'] = { type: 'text', text: '' };
    expect(buildSubmission(q, st)).toEqual([]);
  });
});

describe('max_recipients', () => {
  const q = question({
    type: 'text',
    details: {},
    recipient_type: 'students',
    max_recipients: 2,
    answers: [{ recipient_key: 's:3', answer: { text: 'x' }, giver_comment: null }],
  });
  it('is capped only when the cap is below the recipient count', () => {
    expect(isCapped(q)).toBe(true);
    expect(isCapped({ ...q, max_recipients: 3 })).toBe(false);
    expect(isCapped({ ...q, max_recipients: null })).toBe(false);
  });
  it('starts with the saved recipients chosen and sends only chosen rows', () => {
    const st = initState(q);
    expect(st.chosen).toEqual(['s:3']);
    st.inputs['s:1'] = { type: 'text', text: 'hidden' };
    expect(buildSubmission(q, st).map((r) => r.recipient_key)).toEqual(['s:3']);
    st.chosen = toggleChosen(q, st.chosen, 's:1', true);
    expect(activeRecipients(q, st).map((r) => r.recipient_key)).toEqual(['s:1', 's:3']);
    expect(buildSubmission(q, st).map((r) => r.recipient_key)).toEqual(['s:1', 's:3']);
  });
  it('never goes over the cap', () => {
    const chosen = toggleChosen(q, ['s:1', 's:3'], 's:2', true);
    expect(chosen).toEqual(['s:1', 's:3']);
    expect(toggleChosen(q, chosen, 's:1', false)).toEqual(['s:3']);
  });
  it('limits ranks to the cap', () => {
    expect(rankLimit(q)).toBe(2);
    expect(rankLimit({ ...q, max_recipients: null })).toBe(3);
  });
});

describe('isSelfRecipient', () => {
  const me = { name: 'Bo', team: 'T1', section: 'A' };
  const q = { recipient_type: 'own_team_members_including_self' as const };
  it('matches name and team', () => {
    expect(isSelfRecipient(me, q, recipients[1])).toBe(true);
    expect(isSelfRecipient(me, q, recipients[0])).toBe(false);
    expect(isSelfRecipient(me, { recipient_type: 'self' }, recipients[0])).toBe(true);
    expect(isSelfRecipient(undefined, q, recipients[1])).toBe(false);
  });
});
