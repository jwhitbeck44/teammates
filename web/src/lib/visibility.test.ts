import { describe, expect, it } from 'vitest';
import {
  VISIBILITY_PRESETS,
  ResponseParties,
  Viewer,
  VisibilityLists,
  applicableVisibilityTypes,
  canView,
  defaultVisibility,
  describeVisibility,
  isCellEditable,
  isCellOn,
  matchPreset,
  normalizeVisibility,
  presetLists,
  presetsFor,
  setVisibility,
  visibilityLabel,
  visibleNames,
} from './visibility';

const preset = (id: string): VisibilityLists => presetLists(VISIBILITY_PRESETS.find((p) => p.id === id)!);

describe('presets (ARCHITECTURE.md section 7)', () => {
  it('has the four presets with the documented lists', () => {
    expect(VISIBILITY_PRESETS.map((p) => p.id)).toEqual(['team_and_instructors', 'recipient_and_instructors', 'recipient_named', 'instructors_only']);
    expect(preset('team_and_instructors')).toEqual({
      show_responses_to: ['instructors', 'recipient', 'giver_team_members'],
      show_giver_name_to: ['instructors'],
      show_recipient_name_to: ['instructors', 'recipient'],
    });
    expect(preset('recipient_and_instructors')).toEqual({
      show_responses_to: ['recipient', 'instructors'],
      show_giver_name_to: ['instructors'],
      show_recipient_name_to: ['recipient', 'instructors'],
    });
    expect(preset('recipient_named')).toEqual({
      show_responses_to: ['recipient', 'instructors'],
      show_giver_name_to: ['recipient', 'instructors'],
      show_recipient_name_to: ['recipient', 'instructors'],
    });
    expect(preset('instructors_only')).toEqual({
      show_responses_to: ['instructors'],
      show_giver_name_to: ['instructors'],
      show_recipient_name_to: ['instructors'],
    });
  });
  it('the default is instructors only', () => expect(defaultVisibility()).toEqual(preset('instructors_only')));
  it('matches a preset ignoring order and labels anything else Custom', () => {
    const shuffled = { ...preset('team_and_instructors'), show_responses_to: ['giver_team_members', 'instructors', 'recipient'] as VisibilityLists['show_responses_to'] };
    expect(matchPreset(shuffled)?.id).toBe('team_and_instructors');
    expect(visibilityLabel(preset('instructors_only'))).toMatch(/instructors only/);
    expect(visibilityLabel({ show_responses_to: ['students'], show_giver_name_to: [], show_recipient_name_to: [] })).toBe('Custom');
  });
  it('presetLists returns copies', () => {
    const a = preset('instructors_only');
    a.show_responses_to.push('students');
    expect(preset('instructors_only').show_responses_to).toEqual(['instructors']);
  });
  it('contrib only offers the presets that keep recipient and giver team members together', () => {
    const ids = presetsFor('contrib', 'students', 'own_team_members_including_self').map((p) => p.id);
    expect(ids).toEqual(['team_and_instructors', 'instructors_only']);
  });
  it('presets with a recipient are not offered when the path has no recipient', () => {
    expect(presetsFor('text', 'students', 'own_team').map((p) => p.id)).toEqual(['instructors_only']);
    expect(presetsFor('text', 'students', 'own_team_members').map((p) => p.id)).toHaveLength(4);
  });
});

describe('applicable visibility types (redundant ones are hidden)', () => {
  it('giver team members are hidden for instructor givers', () => {
    expect(applicableVisibilityTypes('instructors', 'students')).not.toContain('giver_team_members');
    expect(applicableVisibilityTypes('students', 'students')).toContain('giver_team_members');
  });
  it('recipient is hidden for self, own_team and none', () => {
    for (const r of ['self', 'own_team', 'none'] as const) expect(applicableVisibilityTypes('students', r)).not.toContain('recipient');
  });
  it('recipient team members are hidden for team and own-team recipients and instructors', () => {
    for (const r of ['teams', 'own_team_members', 'instructors', 'self', 'none'] as const) {
      expect(applicableVisibilityTypes('students', r)).not.toContain('recipient_team_members');
    }
    expect(applicableVisibilityTypes('students', 'students')).toContain('recipient_team_members');
  });
});

describe('editor rules', () => {
  const empty: VisibilityLists = { show_responses_to: [], show_giver_name_to: [], show_recipient_name_to: [] };
  const set = (l: VisibilityLists, vt: Parameters<typeof setVisibility>[1], c: Parameters<typeof setVisibility>[2], on: boolean) =>
    setVisibility(l, vt, c, on, 'students', 'students');

  it('granting a name right also grants the response right', () => {
    const a = set(empty, 'students', 'giver_name', true);
    expect(a.show_responses_to).toEqual(['students']);
    expect(a.show_giver_name_to).toEqual(['students']);
    expect(a.show_recipient_name_to).toEqual([]);
    const b = set(empty, 'students', 'recipient_name', true);
    expect(b.show_responses_to).toEqual(['students']);
  });
  it('granting the recipient the response also grants the recipient name', () => {
    const a = set(empty, 'recipient', 'response', true);
    expect(a.show_recipient_name_to).toEqual(['recipient']);
  });
  it('removing the response right removes both name rights', () => {
    const start = preset('recipient_named');
    const a = set(start, 'recipient', 'response', false);
    expect(a.show_responses_to).toEqual(['instructors']);
    expect(a.show_giver_name_to).toEqual(['instructors']);
    expect(a.show_recipient_name_to).toEqual(['instructors']);
  });
  it("the recipient's own recipient-name cell cannot be edited", () => {
    expect(isCellEditable('recipient', 'recipient_name')).toBe(false);
    expect(isCellEditable('recipient', 'giver_name')).toBe(true);
    const start = preset('recipient_named');
    expect(set(start, 'recipient', 'recipient_name', false)).toBe(start);
  });
  it('ignores types that do not apply to the path', () => {
    const r = setVisibility(empty, 'giver_team_members', 'response', true, 'instructors', 'students');
    expect(r).toBe(empty);
  });
  it('does not modify its input and keeps canonical order', () => {
    const start = preset('instructors_only');
    const snapshot = JSON.stringify(start);
    const a = set(start, 'recipient', 'response', true);
    expect(JSON.stringify(start)).toBe(snapshot);
    expect(a.show_responses_to).toEqual(['recipient', 'instructors']);
  });
  it('isCellOn reads the right list', () => {
    const l = preset('team_and_instructors');
    expect(isCellOn(l, 'giver_team_members', 'response')).toBe(true);
    expect(isCellOn(l, 'giver_team_members', 'giver_name')).toBe(false);
  });
  it('normalizeVisibility repairs inconsistent lists', () => {
    const n = normalizeVisibility({ show_responses_to: ['recipient', 'instructors'], show_giver_name_to: ['students', 'instructors'], show_recipient_name_to: ['students'] });
    expect(n).toEqual({ show_responses_to: ['recipient', 'instructors'], show_giver_name_to: ['instructors'], show_recipient_name_to: ['recipient'] });
  });
  it('describeVisibility reads in plain English', () => {
    expect(describeVisibility(preset('instructors_only'))).toEqual(["Instructors can see the response, the giver's name and the recipient's name."]);
    expect(describeVisibility(preset('recipient_and_instructors'))).toEqual([
      "Recipient can see the response, the recipient's name, but not the giver's name.",
      "Instructors can see the response, the giver's name and the recipient's name.",
    ]);
    expect(describeVisibility(empty)).toEqual(['Nobody but the giver can see the responses.']);
  });
});

describe('canView for students (same logic as SQL can_view)', () => {
  // Giver Ann (s:1) on team A|Red gives feedback to Bob (s:2), same team. Cy (s:3) is on A|Blue. Dee (s:4) is on B|Red? no: B|Green.
  const stu = (id: string, section: string, team: string): Viewer => ({ kind: 'student', student: { id, section, team } });
  const ann = stu('1', 'A', 'Red');
  const bob = stu('2', 'A', 'Red');
  const cy = stu('3', 'A', 'Blue');
  const redInOtherSection = stu('9', 'B', 'Red');
  const toTeammate: ResponseParties = { giver_key: 's:1', recipient_key: 's:2', giver_team_key: 't:A|Red', recipient_team_key: 't:A|Red' };
  const toOtherTeamMember: ResponseParties = { giver_key: 's:1', recipient_key: 's:3', giver_team_key: 't:A|Red', recipient_team_key: 't:A|Blue' };
  const toTeam: ResponseParties = { giver_key: 's:1', recipient_key: 't:A|Blue', giver_team_key: 't:A|Red', recipient_team_key: 't:A|Blue' };

  it('instructors see everything', () => {
    expect(canView(preset('instructors_only'), toTeammate, { kind: 'instructor' })).toEqual({ sees_response: true, sees_giver_name: true, sees_recipient_name: true });
  });
  it('the giver always sees their own response with full names', () => {
    expect(canView(preset('instructors_only'), toTeammate, ann)).toEqual({ sees_response: true, sees_giver_name: true, sees_recipient_name: true });
  });

  it('preset: shown anonymously to recipient, visible to instructors', () => {
    const l = preset('recipient_and_instructors');
    expect(canView(l, toTeammate, bob)).toEqual({ sees_response: true, sees_giver_name: false, sees_recipient_name: true });
    expect(canView(l, toTeammate, cy)).toEqual({ sees_response: false, sees_giver_name: false, sees_recipient_name: false });
  });
  it('preset: shown anonymously to recipient and giver team members', () => {
    const l = preset('team_and_instructors');
    // Bob is both recipient and a giver-team member.
    expect(canView(l, toTeammate, bob).sees_giver_name).toBe(false);
    // Someone on the giver's team who is not the recipient still sees the response, not the giver name.
    const dan = stu('7', 'A', 'Red');
    expect(canView(l, toOtherTeamMember, dan)).toEqual({ sees_response: true, sees_giver_name: false, sees_recipient_name: false });
    expect(canView(l, toOtherTeamMember, cy)).toEqual({ sees_response: true, sees_giver_name: false, sees_recipient_name: true });
  });
  it('preset: visible to recipient (named)', () => {
    expect(canView(preset('recipient_named'), toTeammate, bob)).toEqual({ sees_response: true, sees_giver_name: true, sees_recipient_name: true });
  });
  it('preset: instructors only hides everything from other students', () => {
    expect(canView(preset('instructors_only'), toTeammate, bob).sees_response).toBe(false);
  });

  it('a team recipient is seen by every member of that team', () => {
    const l = preset('recipient_and_instructors');
    expect(canView(l, toTeam, cy).sees_response).toBe(true);
    expect(canView(l, toTeam, bob).sees_response).toBe(false);
  });
  it('teams with the same name in different sections are different teams', () => {
    const l = preset('team_and_instructors');
    expect(canView(l, toTeammate, redInOtherSection).sees_response).toBe(false);
  });
  it('students list shows to any student; instructors list never does', () => {
    const open: VisibilityLists = { show_responses_to: ['students'], show_giver_name_to: ['students'], show_recipient_name_to: [] };
    expect(canView(open, toTeammate, cy)).toEqual({ sees_response: true, sees_giver_name: true, sees_recipient_name: false });
    expect(canView({ show_responses_to: ['instructors'], show_giver_name_to: [], show_recipient_name_to: [] }, toTeammate, cy).sees_response).toBe(false);
  });
  it('recipient_team_members sees responses about someone on their team', () => {
    const l: VisibilityLists = { show_responses_to: ['recipient_team_members'], show_giver_name_to: [], show_recipient_name_to: ['recipient_team_members'] };
    const eve = stu('8', 'A', 'Blue');
    expect(canView(l, toOtherTeamMember, eve)).toEqual({ sees_response: true, sees_giver_name: false, sees_recipient_name: true });
    expect(canView(l, toOtherTeamMember, bob).sees_response).toBe(false);
  });
  it('instructor recipients and no recipient have no team', () => {
    const toInstructor: ResponseParties = { giver_key: 's:1', recipient_key: 'i:x', giver_team_key: 't:A|Red', recipient_team_key: null };
    expect(canView(preset('recipient_and_instructors'), toInstructor, bob).sees_response).toBe(false);
    expect(canView({ show_responses_to: ['giver_team_members'], show_giver_name_to: [], show_recipient_name_to: [] }, toInstructor, bob).sees_response).toBe(true);
  });

  it('visibleNames shows Anonymous where hidden', () => {
    expect(visibleNames({ sees_response: true, sees_giver_name: false, sees_recipient_name: true }, 'Ann', 'Bob')).toEqual({ giver_name: 'Anonymous', recipient_name: 'Bob' });
  });
});
