import { describe, expect, it } from 'vitest';
import {
  ANY_RECIPIENT_KEY,
  buildPartyIndex,
  buildResultsQuestions,
  contribTeamsOf,
  groupBy,
  inSection,
  missingForQuestion,
  missingResponses,
  nonSubmitters,
  submissionStatus,
  toResultsResponses,
  toStatResponses,
  type ResultsInstructor,
  type ResultsQuestionInput,
  type ResultsResponseInput,
  type ResultsStudent,
} from './results';
import { buildResultsCsv } from './csv';
import { questionStats } from './stats';

const st = (id: string, section: string, team: string, name: string): ResultsStudent => ({ id, section, team, name, email: `${id}@x.edu` });
const students: ResultsStudent[] = [
  st('a1', 'S1', 'T1', 'Ann'),
  st('a2', 'S1', 'T1', 'Bob'),
  st('a3', 'S1', 'T1', 'Cy'),
  st('b1', 'S2', 'T2', 'Dee'),
  st('b2', 'S2', 'T2', 'Eve'),
];
const instructors: ResultsInstructor[] = [
  { id: 'i1', display_name: 'Prof', email: 'p@x.edu', is_displayed_to_students: true, role: 'coowner' },
  { id: 'i2', display_name: 'Obs', email: 'o@x.edu', is_displayed_to_students: true, role: 'observer' },
];

const qText: ResultsQuestionInput = {
  id: 'q1', number: 1, type: 'text', brief: 'Feedback', details: {}, giver_type: 'students', recipient_type: 'own_team_members', max_recipients: null,
};
const qNum: ResultsQuestionInput = {
  id: 'q2', number: 2, type: 'numscale', brief: 'Rate', details: { min: 1, max: 5, step: 1 }, giver_type: 'students', recipient_type: 'own_team_members_including_self', max_recipients: null,
};
const qInstr: ResultsQuestionInput = {
  id: 'q3', number: 3, type: 'text', brief: 'Instr', details: {}, giver_type: 'instructors', recipient_type: 'students', max_recipients: null,
};

const row = (q: string, giver: string, recipient: string, answer: unknown, updated_at = '2026-01-01T00:00:00Z'): ResultsResponseInput => ({
  question_id: q, giver_key: giver, recipient_key: recipient, answer, giver_comment: null, updated_at,
});

describe('party index', () => {
  it('resolves students, teams, instructors, none and removed people', () => {
    const idx = buildPartyIndex(students, instructors);
    expect(idx.party('s:a1')).toMatchObject({ name: 'Ann', team: 'T1', kind: 'student', email: 'a1@x.edu' });
    expect(idx.party('t:S1|T1')).toMatchObject({ name: 'T1', kind: 'team' });
    expect(idx.party('i:i1')).toMatchObject({ name: 'Prof', kind: 'instructor' });
    expect(idx.party('none').kind).toBe('none');
    expect(idx.party('s:gone').name).toBe('(removed)');
    expect(idx.party('t:S9|Gone').name).toBe('Gone');
    expect(idx.section('s:b1')).toBe('S2');
    expect(idx.section('t:S1|T1')).toBe('S1');
    expect(idx.section('i:i1')).toBeNull();
  });
});

describe('missing responses', () => {
  it('lists expected recipients minus answered, per giver', () => {
    const rows = [row('q1', 's:a1', 's:a2', { text: 'x' }), row('q1', 's:b1', 's:b2', { text: 'y' })];
    const m = missingForQuestion(qText, rows, students, instructors);
    const pairs = m.map((x) => `${x.giver_key}>${x.recipient_key}`).sort();
    expect(pairs).toEqual(['s:a1>s:a3', 's:a2>s:a1', 's:a2>s:a3', 's:a3>s:a1', 's:a3>s:a2', 's:b2>s:b1'].sort());
  });

  it('only instructors who may submit are givers', () => {
    const m = missingForQuestion(qInstr, [], students, instructors);
    expect(new Set(m.map((x) => x.giver_key))).toEqual(new Set(['i:i1']));
    expect(m).toHaveLength(5);
  });

  it('gives one placeholder row to a giver with no answers when recipients are limited', () => {
    const q = { ...qText, recipient_type: 'students' as const, max_recipients: 2 };
    const rows = [row('q1', 's:a1', 's:b1', { text: 'x' })];
    const m = missingForQuestion(q, rows, students, instructors);
    expect(m).toHaveLength(4);
    expect(m.every((x) => x.recipient_key === ANY_RECIPIENT_KEY)).toBe(true);
    expect(m.some((x) => x.giver_key === 's:a1')).toBe(false);
  });

  it('collects over questions and ignores rows of other questions', () => {
    const rows = [row('q2', 's:a1', 's:a1', { value: 3 })];
    const all = missingResponses([qText, qNum], rows, students, instructors);
    expect(all.filter((x) => x.question_id === 'q2' && x.giver_key === 's:a1')).toHaveLength(2);
    expect(all.filter((x) => x.question_id === 'q1' && x.giver_key === 's:a1')).toHaveLength(2);
  });
});

describe('submission status and non-submitters', () => {
  const rows = [
    row('q1', 's:a1', 's:a2', { text: 'x' }, '2026-01-02T00:00:00Z'),
    row('q2', 's:a1', 's:a1', { value: 3 }, '2026-01-03T00:00:00Z'),
    row('q3', 'i:i1', 's:a1', { text: 'z' }, '2026-02-01T00:00:00Z'),
  ];
  it('counts student rows and finds the latest update', () => {
    const s = submissionStatus(students, rows);
    expect(s.get('a1')).toEqual({ student_id: 'a1', submitted: true, count: 2, last_updated: '2026-01-03T00:00:00Z' });
    expect(s.get('b1')).toMatchObject({ submitted: false, count: 0, last_updated: null });
  });
  it('lists non-submitters in roster order', () => {
    expect(nonSubmitters(students, rows).map((x) => x.id)).toEqual(['a2', 'a3', 'b1', 'b2']);
  });
});

describe('section filter', () => {
  const idx = buildPartyIndex(students, instructors);
  it('applies the four modes', () => {
    expect(inSection('s:a1', 's:b1', 'S1', 'giver', idx)).toBe(true);
    expect(inSection('s:a1', 's:b1', 'S1', 'recipient', idx)).toBe(false);
    expect(inSection('s:a1', 's:b1', 'S1', 'either', idx)).toBe(true);
    expect(inSection('s:a1', 's:b1', 'S1', 'both', idx)).toBe(false);
    expect(inSection('s:a1', 's:a2', 'S1', 'both', idx)).toBe(true);
    expect(inSection('i:i1', 's:a1', 'S1', 'giver', idx)).toBe(false);
    expect(inSection('s:b1', 's:b2', null, 'both', idx)).toBe(true);
  });
});

describe('results questions', () => {
  const rows = [
    row('q1', 's:a1', 's:a2', { text: 'good' }),
    row('q2', 's:a1', 's:a1', { value: 4 }),
    row('q2', 's:a1', 's:a2', { value: 5 }),
    row('q2', 's:a2', 's:a1', { value: 3 }),
  ];

  it('builds CSV input with and without missing rows', () => {
    const without = buildResultsQuestions([qNum, qText], rows, students, instructors, { includeMissing: false });
    expect(without.map((q) => q.number)).toEqual([1, 2]);
    expect(without[0].responses).toHaveLength(1);
    expect(without[0].responses[0]).toMatchObject({ giver: { name: 'Ann' }, recipient: { name: 'Bob' }, answer: { text: 'good' } });
    const withMissing = buildResultsQuestions([qNum, qText], rows, students, instructors, { includeMissing: true });
    expect(withMissing[0].responses).toHaveLength(8);
    const missingRows = withMissing[0].responses.filter((r) => r.answer === null);
    // Question 1: team T1 has 3 members (6 pairs) and T2 has 2 (2 pairs); one answered.
    expect(missingRows).toHaveLength(7);
  });

  it('filters by section', () => {
    const out = buildResultsQuestions([qText], rows, students, instructors, { includeMissing: true, section: 'S2', sectionMode: 'giver' });
    expect(out[0].responses.every((r) => r.answer === null && r.giver.team === 'T2')).toBe(true);
    expect(out[0].responses).toHaveLength(2);
  });

  it('adds every student as a contrib member and feeds the CSV builder', () => {
    const qc: ResultsQuestionInput = { ...qNum, id: 'qc', number: 4, type: 'contrib', details: { isZeroSum: false, isNotSureAllowed: false } };
    const crow = [row('qc', 's:a1', 's:a1', { value: 100 }), row('qc', 's:a1', 's:a2', { value: 100 })];
    const out = buildResultsQuestions([qc], crow, students, instructors, { includeMissing: false });
    expect(out[0].contribMembers).toHaveLength(5);
    const csv = buildResultsCsv(out, { includeStats: true });
    expect(csv).toContain('Question 4');
    expect(csv).toContain('Summary Statistics');
  });

  it('builds stat responses that lib/stats accepts', () => {
    const idx = buildPartyIndex(students, instructors);
    const resp = toResultsResponses(rows.filter((r) => r.question_id === 'q2'), idx);
    const stats = questionStats('numscale', qNum.details, toStatResponses(resp));
    expect(stats?.kind).toBe('numscale');
    if (stats?.kind === 'numscale') {
      const ann = stats.rows.find((r) => r.name === 'Ann');
      expect(ann?.average).toBe(3.5);
    }
  });

  it('groups by giver and by recipient, ordered by team then name', () => {
    const idx = buildPartyIndex(students, instructors);
    const resp = toResultsResponses(rows.filter((r) => r.question_id === 'q2'), idx);
    expect(groupBy(resp, 'giver').map((g) => [g.name, g.items.length])).toEqual([['Ann', 2], ['Bob', 1]]);
    expect(groupBy(resp, 'recipient').map((g) => g.name)).toEqual(['Ann', 'Bob']);
  });

  it('groups students into contrib teams', () => {
    const t = contribTeamsOf(students);
    expect(t.map((x) => [x.team, x.members.length])).toEqual([['T1', 3], ['T2', 2]]);
  });
});
