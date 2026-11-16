import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PayloadQuestion, StudentSessionPayload } from '../../lib/studentTypes';
import SubmissionForm, { SubmissionForm as Named, toQErrors } from './SubmissionForm';

const recipients = [
  { recipient_key: 's:1', display_name: 'Ann', team_key: 't:A|T1' },
  { recipient_key: 's:2', display_name: 'Bo', team_key: 't:A|T1' },
];
const base = {
  description: 'desc',
  giver_type: 'students' as const,
  recipient_type: 'own_team_members_including_self' as const,
  max_recipients: null,
  recipients,
  answers: [],
  show_responses_to: ['instructors' as const],
  show_giver_name_to: ['instructors' as const],
  show_recipient_name_to: ['instructors' as const],
};
const questions = [
  { type: 'text', details: { recommendedLength: 50 } },
  { type: 'mcq', details: { choices: ['A', 'B'], otherEnabled: true } },
  { type: 'msq', details: { choices: ['A', 'B'], otherEnabled: true, maxSelectable: 2 } },
  { type: 'numscale', details: { min: 1, max: 5, step: 1 } },
  { type: 'constsum_options', details: { options: ['x', 'y'], points: 10, pointsPerOption: false, distribute: 'none' } },
  { type: 'constsum_recipients', details: { points: 100, pointsPerOption: false, distribute: 'none' } },
  { type: 'contrib', details: { isZeroSum: true, isNotSureAllowed: false } },
  { type: 'rubric', details: { choices: ['Low', 'High'], subQuestions: ['s1'], descriptions: [['d1', 'd2']] } },
  { type: 'rank_options', details: { options: ['p', 'q'], duplicatesAllowed: false } },
  { type: 'rank_recipients', details: { duplicatesAllowed: false } },
].map((x, i) => ({ ...base, id: `q${i}`, number: i + 1, brief: `Brief ${i + 1}`, ...x })) as PayloadQuestion[];

const payload: StudentSessionPayload = {
  course: { name: 'Course', code: 'C1', time_zone: 'America/Denver' },
  student: { name: 'Ann', team: 'T1', section: 'A' },
  session: {
    id: 's1',
    name: 'Session',
    instructions: 'Be kind.',
    opens_at: '2026-11-01T00:00:00Z',
    closes_at: '2026-12-01T00:00:00Z',
    grace_minutes: 15,
    deadline: '2026-12-01T00:15:00Z',
    status: 'open',
    published: false,
  },
  questions,
};

describe('SubmissionForm', () => {
  it('is exported as default and named', () => {
    expect(SubmissionForm).toBe(Named);
  });
  it('renders all ten question types with Save buttons and a Save all bar', () => {
    const html = renderToStaticMarkup(createElement(SubmissionForm, { payload, onSaveQuestion: async () => {} }));
    for (const q of questions) expect(html).toContain(q.brief);
    expect(html).toContain('Be kind.');
    expect(html).toContain('Equal share + 10%');
    expect(html).toContain('Who can see your answer');
    expect(html).toContain('Save all');
    expect(html.match(/>Save</g)?.length).toBe(10);
    expect(html).toContain('Ann (you)');
  });
  it('has no save buttons when read only', () => {
    const html = renderToStaticMarkup(createElement(SubmissionForm, { payload, readOnly: true, onSaveQuestion: async () => {} }));
    expect(html).not.toContain('Save all');
    expect(html).not.toContain('>Save<');
  });
  it('shows the picker for max_recipients', () => {
    const capped = { ...payload, questions: [{ ...questions[0], max_recipients: 1 } as PayloadQuestion] };
    const html = renderToStaticMarkup(createElement(SubmissionForm, { payload: capped, onSaveQuestion: async () => {} }));
    expect(html).toContain('Pick up to 1 to answer for');
  });
});

describe('toQErrors', () => {
  it('splits row errors from question errors', () => {
    const e = toQErrors([
      { message: 'a', recipient_key: 's:1' },
      { message: 'b' },
      { message: 'b' },
    ]);
    expect(e).toEqual({ general: ['b'], rows: { 's:1': ['a'] } });
    expect(toQErrors([{ message: 'a', recipient_key: 's:1' }]).general).toEqual(['Fix the problems marked below.']);
  });
});
