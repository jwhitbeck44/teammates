import { describe, expect, it } from 'vitest';
import { NA, NSB, NSU } from './contrib';
import {
  StatRecipient,
  StatResponse,
  choiceStats,
  computeOverallRanks,
  constsumOptionsStats,
  constsumRecipientsStats,
  contribStats,
  normalizeRanks,
  numscaleStats,
  questionStats,
  rankOptionsStats,
  rankRecipientsStats,
  round2,
  rubricStats,
} from './stats';

const rec = (id: string, name: string, team = 'T1', kind: StatRecipient['kind'] = 'student'): StatRecipient => ({
  key: `s:${id}`,
  name,
  email: `${name.toLowerCase()}@x.edu`,
  team,
  team_key: `t:A|${team}`,
  kind,
});
const ann = rec('1', 'Ann');
const bob = rec('2', 'Bob');
const cy = rec('3', 'Cy');
const resp = <A>(giver: StatRecipient | string, recipient: StatRecipient, answer: A): StatResponse<A> => ({
  giver_key: typeof giver === 'string' ? giver : giver.key,
  recipient,
  answer,
});

describe('round2', () => {
  it('rounds like Java Math.round(x * 100) / 100', () => {
    expect(round2(5 / 3)).toBe(1.67);
    expect(round2(1.005)).toBe(1); // 100.49999 in floating point, as in Java
    expect(round2(2.5)).toBe(2.5);
    expect(round2(-0.001)).toBe(0);
    expect(Object.is(round2(-0.001), -0)).toBe(false);
  });
});

describe('numscale', () => {
  it('computes average, min, max and average excluding self', () => {
    const { rows } = numscaleStats([
      resp(ann, ann, { value: 5 }),
      resp(bob, ann, { value: 3 }),
      resp(cy, ann, { value: 4 }),
      resp(ann, bob, { value: 2 }),
    ]);
    expect(rows).toEqual([
      { recipient_key: 's:1', name: 'Ann', email: 'ann@x.edu', team: 'T1', average: 4, min: 3, max: 5, average_excluding_self: 3.5 },
      { recipient_key: 's:2', name: 'Bob', email: 'bob@x.edu', team: 'T1', average: 2, min: 2, max: 2, average_excluding_self: 2 },
    ]);
  });
  it('excludes self from the second average and leaves it null for self-only', () => {
    const { rows } = numscaleStats([resp(ann, ann, { value: 4 })]);
    expect(rows[0].average).toBe(4);
    expect(rows[0].average_excluding_self).toBeNull();
  });
  it('rounds to two decimals', () => {
    const { rows } = numscaleStats([1, 1, 2].map((v, i) => resp(`s:${10 + i}`, ann, { value: v })));
    expect(rows[0].average).toBe(1.33);
  });
  it('sorts by team then name and skips responses without a recipient', () => {
    const zed = rec('9', 'Zed', 'A-team');
    const none: StatRecipient = { key: 'none', name: '(no recipient)', email: null, team: '', kind: 'none' };
    const { rows } = numscaleStats([resp(ann, bob, { value: 1 }), resp(ann, zed, { value: 1 }), resp(ann, none, { value: 1 }), resp(bob, ann, { value: 1 })]);
    expect(rows.map((r) => r.name)).toEqual(['Zed', 'Ann', 'Bob']);
  });
  it('ignores malformed answers', () => {
    expect(numscaleStats([resp(ann, bob, { value: 'x' }), resp(ann, bob, null)]).rows).toEqual([]);
  });
});

describe('mcq and msq', () => {
  it('mcq counts choices and other, with percentages', () => {
    const s = choiceStats({ choices: ['a', 'b'], otherEnabled: true }, [
      resp(ann, bob, { choice: 'a' }),
      resp(bob, bob, { choice: 'a' }),
      resp(cy, bob, { choice: 'b' }),
      resp('s:9', bob, { other: 'zzz' }),
    ]);
    expect(s.has_answers).toBe(true);
    expect(s.rows).toEqual([
      { option: 'a', count: 2, percentage: 50 },
      { option: 'b', count: 1, percentage: 25 },
      { option: 'Other', count: 1, percentage: 25 },
    ]);
  });
  it('msq counts every pick; none of the above counts nothing', () => {
    const s = choiceStats({ choices: ['a', 'b', 'c'], otherEnabled: true }, [
      resp(ann, bob, { choices: ['a', 'b'] }),
      resp(bob, bob, { choices: ['a'], other: 'x' }),
      resp(cy, bob, { choices: [] }),
    ]);
    expect(s.total).toBe(4);
    expect(s.rows).toEqual([
      { option: 'a', count: 2, percentage: 50 },
      { option: 'b', count: 1, percentage: 25 },
      { option: 'c', count: 0, percentage: 0 },
      { option: 'Other', count: 1, percentage: 25 },
    ]);
  });
  it('reports no answers and zero percentages when nothing was chosen', () => {
    const s = choiceStats({ choices: ['a', 'b'], otherEnabled: false }, [resp(ann, bob, { choices: [] })]);
    expect(s.has_answers).toBe(false);
    expect(s.rows.every((r) => r.percentage === 0)).toBe(true);
  });
  it('percentages are rounded to two decimals', () => {
    const s = choiceStats({ choices: ['a', 'b', 'c'], otherEnabled: false }, [resp(ann, bob, { choice: 'a' }), resp(bob, bob, { choice: 'b' }), resp(cy, bob, { choice: 'c' })]);
    expect(s.rows.map((r) => r.percentage)).toEqual([33.33, 33.33, 33.33]);
  });
});

describe('constsum_options', () => {
  it('collects sorted points, total and average per option', () => {
    const { rows } = constsumOptionsStats({ options: ['x', 'y'], points: 100, pointsPerOption: false, distribute: 'none' }, [
      resp(ann, bob, { points: [70, 30] }),
      resp(bob, bob, { points: [20, 80] }),
      resp(cy, bob, { points: [50, 50] }),
    ]);
    expect(rows).toEqual([
      { option: 'x', points_received: [20, 50, 70], total: 140, average: 46.67 },
      { option: 'y', points_received: [30, 50, 80], total: 160, average: 53.33 },
    ]);
  });
  it('gives zeros without responses', () => {
    const { rows } = constsumOptionsStats({ options: ['x', 'y'], points: 100, pointsPerOption: false, distribute: 'none' }, []);
    expect(rows[0]).toEqual({ option: 'x', points_received: [], total: 0, average: 0 });
  });
});

describe('constsum_recipients', () => {
  it('computes total, average and average excluding self per recipient', () => {
    const { rows } = constsumRecipientsStats([
      resp(ann, ann, { points: 100 }),
      resp(bob, ann, { points: 110 }),
      resp(cy, ann, { points: 90 }),
      resp(ann, bob, { points: 100 }),
    ]);
    expect(rows[0]).toEqual({
      recipient_key: 's:1',
      name: 'Ann',
      email: 'ann@x.edu',
      team: 'T1',
      points_received: [90, 100, 110],
      total: 300,
      average: 100,
      average_excluding_self: 100,
    });
    expect(rows[1].points_received).toEqual([100]);
  });
});

describe('rubric', () => {
  const d = { choices: ['Poor', 'Good'], subQuestions: ['Effort', 'Quality'], descriptions: [['', ''], ['', '']] };
  it('counts per choice with row percentages, and a second table without self', () => {
    const s = rubricStats(d, [
      resp(ann, ann, { choices: [1, 1] }),
      resp(bob, ann, { choices: [0, -1] }),
      resp(cy, ann, { choices: [1, 0] }),
    ]);
    expect(s.rows).toEqual([
      { sub_question: 'Effort', cells: [{ count: 1, percentage: 33.33 }, { count: 2, percentage: 66.67 }] },
      { sub_question: 'Quality', cells: [{ count: 1, percentage: 50 }, { count: 1, percentage: 50 }] },
    ]);
    expect(s.rows_exclude_self[0].cells).toEqual([{ count: 1, percentage: 50 }, { count: 1, percentage: 50 }]);
    expect(s.rows_exclude_self[1].cells).toEqual([{ count: 1, percentage: 100 }, { count: 0, percentage: 0 }]);
  });
  it('an empty row has 0 percent everywhere', () => {
    const s = rubricStats(d, []);
    expect(s.rows[0].cells).toEqual([{ count: 0, percentage: 0 }, { count: 0, percentage: 0 }]);
  });
});

describe('rank helpers', () => {
  it('normalizeRanks compacts to dense ranks and keeps null', () => {
    expect(normalizeRanks([1, 3, null])).toEqual([1, 2, null]);
    expect(normalizeRanks([5, 2, 9])).toEqual([2, 1, 3]);
    expect(normalizeRanks([2, 2, 7])).toEqual([1, 1, 2]);
    expect(normalizeRanks([null, null])).toEqual([null, null]);
  });
  it('computeOverallRanks orders by average, ties share a rank and the next rank skips', () => {
    const r = computeOverallRanks(
      new Map([
        ['a', [1, 2]],
        ['b', [2, 1]],
        ['c', [3, 3]],
        ['d', []],
      ]),
    );
    expect([...r.entries()]).toEqual([['a', 1], ['b', 1], ['c', 3]]);
    expect(r.has('d')).toBe(false);
  });
});

describe('rank_options', () => {
  it('compacts each response, collects ranks and gives overall ranks', () => {
    const { rows } = rankOptionsStats({ options: ['x', 'y', 'z'], duplicatesAllowed: false }, [
      resp(ann, bob, { ranks: [1, 3, null] }), // compacts to 1, 2, null
      resp(bob, bob, { ranks: [2, 1, 3] }),
    ]);
    expect(rows).toEqual([
      { option: 'x', ranks_received: [1, 2], overall_rank: 1 },
      { option: 'y', ranks_received: [1, 2], overall_rank: 1 },
      { option: 'z', ranks_received: [3], overall_rank: 3 },
    ]);
  });
  it('an option nobody ranked has no overall rank', () => {
    const { rows } = rankOptionsStats({ options: ['x', 'y'], duplicatesAllowed: false }, [resp(ann, bob, { ranks: [1, null] })]);
    expect(rows[1]).toEqual({ option: 'y', ranks_received: [], overall_rank: null });
  });
});

describe('rank_recipients', () => {
  it('computes self rank, overall ranks, ranks excluding self and ranks in team', () => {
    const { rows } = rankRecipientsStats([
      resp(ann, ann, { rank: 1 }),
      resp(ann, bob, { rank: 2 }),
      resp(ann, cy, { rank: 3 }),
      resp(bob, ann, { rank: 2 }),
      resp(bob, bob, { rank: 1 }),
      resp(bob, cy, { rank: 3 }),
    ]);
    expect(rows.map((r) => [r.name, r.ranks_received, r.self_rank, r.overall_rank, r.rank_excluding_self, r.rank_in_team, r.rank_in_team_excluding_self])).toEqual([
      ['Ann', [1, 2], 1, 1, 1, 1, 1],
      ['Bob', [1, 2], 1, 1, 1, 1, 1],
      ['Cy', [3, 3], null, 3, 3, 3, 3],
    ]);
  });
  it('ranks within each team separately and only for student recipients', () => {
    const dee = rec('4', 'Dee', 'T2');
    const inst: StatRecipient = { key: 'i:9', name: 'Prof', email: null, team: '', kind: 'instructor' };
    const { rows } = rankRecipientsStats([resp(ann, ann, { rank: 2 }), resp(ann, dee, { rank: 1 }), resp(ann, inst, { rank: 3 })]);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.Dee.overall_rank).toBe(1);
    expect(by.Dee.rank_in_team).toBe(1);
    expect(by.Ann.rank_in_team).toBe(1);
    expect(by.Prof.overall_rank).toBe(3);
    expect(by.Prof.rank_in_team).toBeNull();
  });
});

describe('contrib', () => {
  const team = { team_key: 't:A|T1', team: 'T1', members: [{ key: 's:1', name: 'Ann', email: 'ann@x.edu' }, { key: 's:2', name: 'Bob', email: 'bob@x.edu' }, { key: 's:3', name: 'Cy', email: 'cy@x.edu' }] };
  const values = (m: number[][]) => m.flatMap((row, g) => row.map((value, r) => ({ giver_key: `s:${g + 1}`, recipient_key: `s:${r + 1}`, value })));

  it('an equal team has CC = PC = 100 and diff 0', () => {
    const { rows } = contribStats([team], values([[100, 100, 100], [100, 100, 100], [100, 100, 100]]));
    for (const r of rows) {
      expect([r.claimed, r.perceived, r.diff]).toEqual([100, 100, 0]);
      expect(r.ratings_received).toEqual([100, 100]);
    }
  });
  it('perceived excludes self ratings', () => {
    // Everyone rates Ann 100 except Ann, who claims 140 for herself.
    const { rows } = contribStats([team], values([[140, 80, 80], [100, 100, 100], [100, 100, 100]]));
    expect(rows[0].claimed).toBe(140);
    expect(rows[0].perceived).toBeLessThan(rows[0].claimed);
  });
  it('a member who did not submit has claimed -999 and diff -999', () => {
    const { rows } = contribStats([team], values([[100, 100, 100], [100, 100, 100]]).concat([]));
    expect(rows[2].claimed).toBe(NSB);
    expect(rows[2].diff).toBe(NSB);
    expect(rows[2].perceived).toBe(100);
  });
  it('not sure shows as -101 and has no diff', () => {
    const { rows } = contribStats([team], values([[NSU, 100, 100], [100, 100, 100], [100, 100, 100]]));
    expect(rows[0].claimed).toBe(NSU);
    expect(rows[0].diff).toBe(NSB);
  });
  it('a lone member has no perceived value', () => {
    const { rows } = contribStats([{ team_key: 't:A|S', team: 'S', members: [team.members[0]] }], values([[100]]));
    expect(rows[0].perceived).toBe(NA);
  });
  it('sorts rows by team then name', () => {
    const t2 = { team_key: 't:A|A1', team: 'A1', members: [{ key: 's:9', name: 'Zed', email: 'z@x' }] };
    const { rows } = contribStats([team, t2], []);
    expect(rows.map((r) => r.name)).toEqual(['Zed', 'Ann', 'Bob', 'Cy']);
  });
});

describe('questionStats dispatcher', () => {
  it('returns null for text and a tagged result for the others', () => {
    expect(questionStats('text', {}, [])).toBeNull();
    expect(questionStats('numscale', { min: 1, max: 5, step: 1 }, [])?.kind).toBe('numscale');
    expect(questionStats('mcq', { choices: ['a', 'b'], otherEnabled: false }, [])?.kind).toBe('choice');
    expect(questionStats('msq', { choices: ['a', 'b'], otherEnabled: false }, [])?.kind).toBe('choice');
    expect(questionStats('constsum_options', { options: ['a', 'b'], points: 1, pointsPerOption: false, distribute: 'none' }, [])?.kind).toBe('constsum_options');
    expect(questionStats('constsum_recipients', {}, [])?.kind).toBe('constsum_recipients');
    expect(questionStats('rubric', { choices: ['a', 'b'], subQuestions: ['s'], descriptions: [['', '']] }, [])?.kind).toBe('rubric');
    expect(questionStats('rank_options', { options: ['a', 'b'], duplicatesAllowed: false }, [])?.kind).toBe('rank_options');
    expect(questionStats('rank_recipients', {}, [])?.kind).toBe('rank_recipients');
    expect(questionStats('contrib', {}, [], [])?.kind).toBe('contrib');
  });
  it('builds contrib values from responses', () => {
    const team = { team_key: 't:A|T1', team: 'T1', members: [{ key: 's:1', name: 'Ann', email: 'a@x' }, { key: 's:2', name: 'Bob', email: 'b@x' }] };
    const s = questionStats('contrib', {}, [resp(ann, ann, { value: 100 }), resp(ann, bob, { value: 100 }), resp(bob, ann, { value: 100 }), resp(bob, bob, { value: 100 })], [team]);
    expect(s?.kind === 'contrib' && s.rows.map((r) => r.claimed)).toEqual([100, 100]);
  });
});
