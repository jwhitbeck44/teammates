import { describe, expect, it } from 'vitest';
import {
  RosterInstructor,
  RosterStudent,
  allowedGiverTypes,
  allowedRecipientTypes,
  compareStudents,
  giverKey,
  instructorGiver,
  isAllowedPath,
  recipientLimit,
  resolveRecipients,
  sortRoster,
  studentGiver,
  teamsOf,
} from './recipients';
import { RECIPIENT_TYPES, RecipientType, teamKey } from './types';

// Roster in deliberately shuffled order.
const S = (id: string, section: string, team: string, name: string): RosterStudent => ({ id, section, team, name });
const roster: RosterStudent[] = [
  S('4', 'B', 'Green', 'Dee'),
  S('2', 'A', 'Red', 'Bob'),
  S('3', 'A', 'Blue', 'Cy'),
  S('1', 'A', 'Red', 'Ann'),
  S('5', 'B', 'Red', 'Eve'), // same team name in another section is a different team
];
const instructors: RosterInstructor[] = [
  { id: 'i2', display_name: 'Zed', is_displayed_to_students: true },
  { id: 'i1', display_name: 'Amy', is_displayed_to_students: true },
  { id: 'i3', display_name: 'Hidden', is_displayed_to_students: false },
];
const ann = roster[3];
const keys = (rt: RecipientType, giver = studentGiver(ann), giverType: 'students' | 'instructors' = 'students') =>
  resolveRecipients({ giver_type: giverType, recipient_type: rt }, giver, roster, instructors).map((r) => r.recipient_key);

describe('roster order', () => {
  it('sorts by section, team, then name', () => {
    expect(sortRoster(roster).map((s) => s.name)).toEqual(['Cy', 'Ann', 'Bob', 'Dee', 'Eve']);
    expect(compareStudents(roster[0], roster[0])).toBe(0);
  });
  it('lists distinct teams per section', () => {
    expect(teamsOf(roster)).toEqual([
      { section: 'A', team: 'Blue' },
      { section: 'A', team: 'Red' },
      { section: 'B', team: 'Green' },
      { section: 'B', team: 'Red' },
    ]);
  });
});

describe('allowed paths', () => {
  it('contrib only allows students to own_team_members_including_self', () => {
    expect(allowedRecipientTypes('students', 'contrib')).toEqual(['own_team_members_including_self']);
    expect(allowedRecipientTypes('instructors', 'contrib')).toEqual([]);
    expect(allowedGiverTypes('contrib')).toEqual(['students']);
  });
  it('constsum_recipients and rank_recipients drop self, own_team and none', () => {
    for (const t of ['constsum_recipients', 'rank_recipients'] as const) {
      const list = allowedRecipientTypes('students', t);
      for (const bad of ['self', 'own_team', 'none'] as const) expect(list).not.toContain(bad);
      expect(list).toContain('own_team_members_including_self');
      expect(allowedRecipientTypes('instructors', t)).toEqual(['students', 'teams', 'instructors']);
    }
  });
  it('instructor givers get a shorter list', () => {
    expect(allowedRecipientTypes('instructors', 'text')).toEqual(['self', 'students', 'teams', 'instructors', 'none']);
    expect(isAllowedPath('instructors', 'own_team', 'text')).toBe(false);
    expect(isAllowedPath('students', 'own_team', 'text')).toBe(true);
    expect(allowedRecipientTypes('students', 'text')).toHaveLength(10);
  });
});

describe('resolveRecipients for a student giver (Ann, section A, team Red)', () => {
  it('self', () => expect(keys('self')).toEqual(['s:1']));
  it('none gives one row with key none', () => {
    const r = resolveRecipients({ giver_type: 'students', recipient_type: 'none' }, studentGiver(ann), roster, instructors);
    expect(r).toEqual([{ recipient_key: 'none', display_name: '(no recipient)', team_key: null }]);
  });
  it('students', () => expect(keys('students')).toEqual(['s:3', 's:1', 's:2', 's:4', 's:5']));
  it('students_excluding_self', () => expect(keys('students_excluding_self')).toEqual(['s:3', 's:2', 's:4', 's:5']));
  it('teams', () => expect(keys('teams')).toEqual(['t:A|Blue', 't:A|Red', 't:B|Green', 't:B|Red']));
  it('teams_excluding_self drops only the own team (same name in another section stays)', () => {
    expect(keys('teams_excluding_self')).toEqual(['t:A|Blue', 't:B|Green', 't:B|Red']);
  });
  it('own_team', () => expect(keys('own_team')).toEqual(['t:A|Red']));
  it('own_team_members', () => expect(keys('own_team_members')).toEqual(['s:2']));
  it('own_team_members_including_self', () => expect(keys('own_team_members_including_self')).toEqual(['s:1', 's:2']));
  it('instructors lists displayed instructors by display name', () => expect(keys('instructors')).toEqual(['i:i1', 'i:i2']));
  it('student recipients carry the team key and names', () => {
    const r = resolveRecipients({ giver_type: 'students', recipient_type: 'own_team_members' }, studentGiver(ann), roster, instructors);
    expect(r).toEqual([{ recipient_key: 's:2', display_name: 'Bob', team_key: teamKey('A', 'Red') }]);
  });
  it('team recipients are named by team', () => {
    const r = resolveRecipients({ giver_type: 'students', recipient_type: 'own_team' }, studentGiver(ann), roster, instructors);
    expect(r[0]).toEqual({ recipient_key: 't:A|Red', display_name: 'Red', team_key: 't:A|Red' });
  });
  it('a lone student on a team has no own_team_members', () => {
    expect(keys('own_team_members', studentGiver(roster[0]))).toEqual([]);
  });
});

describe('resolveRecipients for an instructor giver', () => {
  const g = instructorGiver(instructors[1]);
  it('self, students, teams, instructors, none', () => {
    expect(keys('self', g, 'instructors')).toEqual(['i:i1']);
    expect(keys('students', g, 'instructors')).toEqual(['s:3', 's:1', 's:2', 's:4', 's:5']);
    expect(keys('teams', g, 'instructors')).toEqual(['t:A|Blue', 't:A|Red', 't:B|Green', 't:B|Red']);
    expect(keys('instructors', g, 'instructors')).toEqual(['i:i1', 'i:i2']);
    expect(keys('none', g, 'instructors')).toEqual(['none']);
  });
  it('team-relative types resolve to nothing', () => {
    for (const t of ['own_team', 'own_team_members', 'own_team_members_including_self', 'students_excluding_self', 'teams_excluding_self'] as const) {
      expect(keys(t, g, 'instructors'), t).toEqual([]);
    }
  });
});

describe('every recipient type resolves without throwing', () => {
  it('returns arrays for all types and givers', () => {
    for (const t of RECIPIENT_TYPES) {
      expect(Array.isArray(keys(t))).toBe(true);
      expect(Array.isArray(keys(t, instructorGiver(instructors[0]), 'instructors'))).toBe(true);
    }
  });
});

describe('giver keys and limits', () => {
  it('builds keys', () => {
    expect(giverKey(studentGiver(ann))).toBe('s:1');
    expect(giverKey(instructorGiver(instructors[0]))).toBe('i:i2');
  });
  it('recipientLimit caps by max_recipients', () => {
    expect(recipientLimit(5, null)).toBe(5);
    expect(recipientLimit(5, 2)).toBe(2);
    expect(recipientLimit(2, 5)).toBe(2);
  });
});
