import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NA,
  NSB,
  NSU,
  averageColumns,
  buildClaimedMatrix,
  calculatePerceivedForStudent,
  calculateTeamEvalResult,
  contribPointToText,
  contribRows,
  contribStudentView,
  isSanitized,
  normalizeValues,
  purgeValuesCorrespondingToSpecialValuesInFilter,
  removeSelfRatings,
  sum,
} from './contrib';

interface MatrixCase {
  name: string;
  input: number[][];
  expected: {
    normalizedClaimed: number[][];
    normalizedPeerContributionRatio: number[][];
    normalizedAveragePerceived: number[];
    denormalizedAveragePerceived: number[][];
  };
}
interface OtherCase {
  name: string;
  function: string;
  input: Record<string, unknown>;
  expected: unknown;
}
interface Fixture {
  constants: { NA: number; NSB: number; NSU: number };
  cases: MatrixCase[];
  other_tests: { name: string; cases: OtherCase[] }[];
}

// vitest runs from web/, the fixture lives in the repo root under supabase/.
const fixturePath = resolve(process.cwd(), '../supabase/tests/fixtures/contrib_cases.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

describe('contrib fixtures', () => {
  it('constants match the fixture file', () => {
    expect(fixture.constants).toEqual({ NA, NSB, NSU });
  });

  it('loaded all matrix cases', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(11);
  });

  describe.each(fixture.cases)('$name', (c) => {
    it('matches the expected matrices (TeamEvalResult)', () => {
      const r = calculateTeamEvalResult(c.input);
      expect(r.normalizedClaimed).toEqual(c.expected.normalizedClaimed);
      expect(r.normalizedPeerContributionRatio).toEqual(c.expected.normalizedPeerContributionRatio);
      expect(r.normalizedAveragePerceived).toEqual(c.expected.normalizedAveragePerceived);
      expect(r.denormalizedAveragePerceived).toEqual(c.expected.denormalizedAveragePerceived);
    });
  });

  const closeArrays = (actual: unknown, expected: unknown) => {
    if (Array.isArray(expected)) {
      expect(Array.isArray(actual)).toBe(true);
      const a = actual as unknown[];
      expect(a.length).toBe(expected.length);
      expected.forEach((e, i) => closeArrays(a[i], e));
    } else if (typeof expected === 'number') {
      expect(actual as number).toBeCloseTo(expected, 6);
    } else {
      expect(actual).toEqual(expected);
    }
  };

  const run = (c: OtherCase): unknown => {
    const i = c.input;
    switch (c.function) {
      case 'normalizeValues':
        return normalizeValues(i.input as number[]);
      case 'TeamEvalResult.removeSelfRatings':
        return removeSelfRatings(i.input as number[][]);
      case 'TeamEvalResult.averageColumns':
        return averageColumns(i.input as number[][]);
      case 'TeamEvalResult.sum':
        return sum(i.input as number[]);
      case 'TeamEvalResult.calculatePerceivedForStudent':
        return calculatePerceivedForStudent(i.claimedSanitizedRow as number[], i.normalizedAveragePerceived as number[]);
      case 'TeamEvalResult.isSanitized':
        return isSanitized(i.array as number[]);
      case 'purgeValuesCorrespondingToSpecialValuesInFilter':
        return purgeValuesCorrespondingToSpecialValuesInFilter(i.filterArray as number[], i.valueArray as number[]);
      default:
        throw new Error(`unknown function ${c.function}`);
    }
  };

  for (const group of fixture.other_tests) {
    describe(group.name, () => {
      it.each(group.cases)('$name', (c) => {
        closeArrays(run(c), c.expected);
      });
    });
  }

  it('covers every function name in the fixture', () => {
    const names = new Set(fixture.other_tests.flatMap((g) => g.cases.map((c) => c.function)));
    expect([...names].sort()).toEqual(
      [
        'TeamEvalResult.averageColumns',
        'TeamEvalResult.calculatePerceivedForStudent',
        'TeamEvalResult.isSanitized',
        'TeamEvalResult.removeSelfRatings',
        'TeamEvalResult.sum',
        'normalizeValues',
        'purgeValuesCorrespondingToSpecialValuesInFilter',
      ].sort(),
    );
  });
});

describe('contrib helpers', () => {
  it('builds the claimed matrix with NSB for missing answers and skips outsiders', () => {
    const m = buildClaimedMatrix(['a', 'b'], [
      { giver_key: 'a', recipient_key: 'a', value: 100 },
      { giver_key: 'a', recipient_key: 'b', value: 100 },
      { giver_key: 'x', recipient_key: 'b', value: 50 },
      { giver_key: 'b', recipient_key: 'zz', value: 50 },
    ]);
    expect(m).toEqual([
      [100, 100],
      [NSB, NSB],
    ]);
  });

  it('computes rows and student views for a small team', () => {
    const keys = ['a', 'b', 'c'];
    const m = [
      [110, 100, 90],
      [100, 100, 100],
      [90, 110, 100],
    ];
    const r = calculateTeamEvalResult(m);
    const rows = contribRows(keys, r);
    expect(rows.map((x) => x.member_key)).toEqual(keys);
    expect(rows[0].claimed).toBe(r.normalizedClaimed[0][0]);
    expect(rows[0].diff).toBe(rows[0].perceived - rows[0].claimed);
    expect(rows[0].ratings_received).toHaveLength(2);
    expect(rows[0].ratings_received[0]).toBeGreaterThanOrEqual(rows[0].ratings_received[1]);
    const v = contribStudentView(r, 1);
    expect(v.my_claim_of_me).toBe(100);
    expect(v.my_claim_of_others).toEqual([100, 100]);
    expect(v.team_view_of_me).toBe(r.denormalizedAveragePerceived[1][1]);
  });

  it('marks diff as NSB when claimed or perceived is negative', () => {
    const r = calculateTeamEvalResult([
      [NSU, 100],
      [100, 100],
    ]);
    const rows = contribRows(['a', 'b'], r);
    expect(rows[0].claimed).toBe(NSU);
    expect(rows[0].diff).toBe(NSB);
  });

  it('turns special values into words', () => {
    expect(contribPointToText(NSU)).toBe('Not Sure');
    expect(contribPointToText(NSB)).toBe('Not Submitted');
    expect(contribPointToText(NA)).toBe('N/A');
    expect(contribPointToText(95)).toBe('95');
  });
});
