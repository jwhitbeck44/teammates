import { describe, expect, it } from 'vitest';
import { TEMPLATE_IDS, getTemplate, listTemplates } from './templates';
import { validateQuestion } from './validation';
import { canView } from './visibility';

describe('templates (spec section e)', () => {
  const point = getTemplate('point_based');
  const pct = getTemplate('percentage_based');

  it('lists the three templates', () => {
    expect(TEMPLATE_IDS).toEqual(['point_based', 'percentage_based', 'empty']);
    expect(listTemplates().map((t) => t.label)).toEqual([
      'Team peer feedback (point-based)',
      'Team peer feedback (percentage-based)',
      'Session with my own questions',
    ]);
    expect(getTemplate('empty').questions).toEqual([]);
  });

  it('both team templates have 5 numbered questions, all students as givers with unlimited recipients', () => {
    for (const t of [point, pct]) {
      expect(t.questions).toHaveLength(5);
      expect(t.questions.map((q) => q.number)).toEqual([1, 2, 3, 4, 5]);
      for (const q of t.questions) {
        expect(q.giver_type).toBe('students');
        expect(q.max_recipients).toBeNull();
      }
    }
  });

  it('point-based question 1 is constsum_recipients with 100 points per recipient', () => {
    const q = point.questions[0];
    expect(q.type).toBe('constsum_recipients');
    expect(q.details).toEqual({ points: 100, pointsPerOption: true, distribute: 'none' });
    expect(q.recipient_type).toBe('own_team_members_including_self');
    expect(q.brief).toBe('How much work did each team member contribute? (response will be shown anonymously to each team member). ');
    expect(q.description).toBe(
      'If a team member did an equal share of the work, give 100 points. If a team member did about 10% more than an equal share of the work, give 110 points, and so on.',
    );
    expect(q.show_responses_to).toEqual(['instructors', 'recipient', 'giver_team_members']);
    expect(q.show_giver_name_to).toEqual(['instructors']);
    expect(q.show_recipient_name_to).toEqual(['instructors', 'recipient']);
  });

  it('percentage-based question 1 is zero-sum contrib with no description', () => {
    const q = pct.questions[0];
    expect(q.type).toBe('contrib');
    expect(q.details).toEqual({ isZeroSum: true, isNotSureAllowed: false });
    expect(q.recipient_type).toBe('own_team_members_including_self');
    expect(q.description).toBe('');
    expect(q.brief).toBe(point.questions[0].brief);
    expect(q.show_responses_to).toEqual(['instructors', 'recipient', 'giver_team_members']);
    expect(q.show_giver_name_to).toEqual(['instructors']);
    expect(q.show_recipient_name_to).toEqual(['instructors', 'recipient']);
  });

  it('questions 2 to 5 are identical in both templates', () => {
    expect(pct.questions.slice(1)).toEqual(point.questions.slice(1));
  });

  it('questions 2 to 5: text, paths, briefs and visibility as in TEAMMATES', () => {
    const [, q2, q3, q4, q5] = point.questions;
    for (const q of [q2, q3, q4, q5]) {
      expect(q.type).toBe('text');
      expect(q.details).toEqual({});
      expect(q.description).toBe('');
    }
    expect([q2, q3, q4, q5].map((q) => q.recipient_type)).toEqual(['self', 'own_team_members', 'own_team', 'own_team_members']);
    expect(q2.brief).toBe('What contributions did you make to the team? (response will be shown to each team member).');
    expect(q3.brief).toBe('What comments do you have regarding each of your team members? (response is confidential and will only be shown to the instructor).');
    expect(q4.brief).toBe('How are the team dynamics thus far? (response is confidential and will only be to the instructor).');
    expect(q5.brief).toBe('What feedback do you have for each of your team members? (response will be shown anonymously to each team member).');
    for (const l of ['show_responses_to', 'show_giver_name_to', 'show_recipient_name_to'] as const) expect(q2[l]).toEqual(['recipient', 'giver_team_members', 'instructors']);
    for (const q of [q3, q4]) {
      expect(q.show_responses_to).toEqual(['instructors']);
      expect(q.show_giver_name_to).toEqual(['instructors']);
      expect(q.show_recipient_name_to).toEqual(['instructors']);
    }
    expect(q5.show_responses_to).toEqual(['recipient', 'instructors']);
    expect(q5.show_giver_name_to).toEqual(['instructors']);
    expect(q5.show_recipient_name_to).toEqual(['recipient', 'instructors']);
  });

  it('every template question passes validateQuestion', () => {
    for (const t of listTemplates()) for (const q of t.questions) expect(validateQuestion(q), `${t.id} q${q.number}`).toEqual([]);
  });

  it('visibility works as described: the work question is anonymous to the recipient', () => {
    const q = point.questions[0];
    const parties = { giver_key: 's:1', recipient_key: 's:2', giver_team_key: 't:A|R', recipient_team_key: 't:A|R' };
    const rights = canView(q, parties, { kind: 'student', student: { id: '2', section: 'A', team: 'R' } });
    expect(rights).toEqual({ sees_response: true, sees_giver_name: false, sees_recipient_name: true });
  });

  it('returns fresh objects every call', () => {
    const a = getTemplate('point_based');
    a.questions[0].show_responses_to.push('students');
    a.questions[0].brief = 'changed';
    const b = getTemplate('point_based');
    expect(b.questions[0].show_responses_to).toEqual(['instructors', 'recipient', 'giver_team_members']);
    expect(b.questions[0].brief).not.toBe('changed');
  });
});
