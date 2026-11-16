// Exact port of TEAMMATES TeamEvalResult.java (GPL-2.0), spec section b.
// Sentinel values are plain numbers (Java ints); see the constants below.
// Rounding follows Java: Math.round is floor(x + 0.5), which JavaScript's Math.round matches.

/** Value not set (uninitialised). */
export const NA = -9999;
/** Giver chose "Not sure". */
export const NSU = -101;
/** Giver did not submit. */
export const NSB = -999;
/** 100 = "Equal share". */
export const EQUAL_SHARE = 100;

export type Matrix = number[][];

function isSpecialValue(value: number): boolean {
  return value === NA || value === NSU || value === NSB;
}

function isValidSpecialValue(value: number): boolean {
  return value === NA || value === NSU;
}

/** Java `(int) value` for doubles: truncate toward zero (NaN becomes 0). */
function toIntTrunc(v: number): number {
  const t = Math.trunc(v);
  return Number.isNaN(t) ? 0 : t === 0 ? 0 : t;
}

/** Java `(int) Math.round(value)`. Avoids returning -0 and mimics NaN and infinity casts. */
function roundToInt(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v === Infinity) return -1; // (int) Long.MAX_VALUE
  if (v === -Infinity) return 0; // (int) Long.MIN_VALUE
  const r = Math.round(v);
  return r === 0 ? 0 : r;
}

export function doubleToInt(input: number[]): number[] {
  return input.map(roundToInt);
}

function doubleToIntMatrix(input: Matrix): Matrix {
  return input.map(doubleToInt);
}

export function isSanitized(array: number[]): boolean {
  return array.every((v) => v !== NSB);
}

function calculateFactor(input: number[]): number {
  let actualSum = 0;
  let count = 0;
  for (const value of input) {
    if (isSpecialValue(toIntTrunc(value))) continue;
    actualSum += value;
    count++;
  }
  const idealSum = count * EQUAL_SHARE * 1.0;
  return actualSum === 0 ? 0 : idealSum / actualSum;
}

function multiplyByFactorRow(factor: number, input: number[]): number[] {
  return input.map((value) => {
    if (isSpecialValue(toIntTrunc(value))) return value;
    return factor === 0 ? value : value * factor;
  });
}

function multiplyByFactor(factor: number, input: Matrix): Matrix {
  return input.map((row) => multiplyByFactorRow(factor, row));
}

/** Scale the non-special entries so they average 100. Special entries are unchanged. */
export function normalizeValues(input: number[]): number[] {
  return multiplyByFactorRow(calculateFactor(input), input);
}

function normalizeMatrix(input: Matrix): Matrix {
  return input.map(normalizeValues);
}

/** Set the diagonal to NA. */
export function removeSelfRatings(input: Matrix): Matrix {
  return input.map((row, i) => row.map((v, j) => (i === j ? NA : v)));
}

function averageColumn(rows: Matrix, columnIndex: number): number {
  let sum = 0;
  let count = 0;
  for (const row of rows) {
    const value = row[columnIndex];
    if (isValidSpecialValue(value)) continue;
    sum += value;
    count++;
  }
  return count === 0 ? NA : sum / count;
}

/** Mean of each column, skipping NA and NSU; NA when nothing is left. */
export function averageColumns(input: Matrix): number[] {
  return input.map((_, i) => averageColumn(input, i));
}

/** Sum skipping NA and NSU. Returns 0 for an empty array and NA when nothing was summed. */
export function sum(input: number[]): number {
  if (input.length === 0) return 0;
  let total = NA;
  for (const value of input) {
    if (!isValidSpecialValue(value)) total = total === NA ? value : total + value;
  }
  return total;
}

/** Blank out entries of `valueArray` where `filterArray` holds a special value. */
export function purgeValuesCorrespondingToSpecialValuesInFilter(filterArray: number[], valueArray: number[]): number[] {
  return filterArray.map((f, i) => {
    const filterValue = toIntTrunc(f);
    if (filterValue === NA || filterValue === NSU || filterValue === NSB) {
      return filterValue === NSU ? NSU : NA;
    }
    return valueArray[i];
  });
}

/** What one student sees as the team's view, scaled to match their own claims. */
export function calculatePerceivedForStudent(claimedSanitizedRow: number[], normalizedAveragePerceived: number[]): number[] {
  const filteredPerceived = purgeValuesCorrespondingToSpecialValuesInFilter(claimedSanitizedRow, normalizedAveragePerceived);
  const filteredActual = doubleToInt(
    purgeValuesCorrespondingToSpecialValuesInFilter(normalizedAveragePerceived, claimedSanitizedRow),
  );
  const sumOfPerceived = sum(filteredPerceived);
  let sumOfActual = toIntTrunc(sum(filteredActual));
  // If the student did not submit
  if (sumOfActual === NA) sumOfActual = sumOfPerceived;
  const factor = sumOfActual / sumOfPerceived;
  return doubleToInt(multiplyByFactorRow(factor, normalizedAveragePerceived));
}

export interface TeamEvalResult {
  /** The raw matrix as given: claimed[giver][recipient]. */
  claimed: Matrix;
  /** Each row scaled to average 100 and rounded. The diagonal is the "claimed" figure (CC). */
  normalizedClaimed: Matrix;
  /** Team's perception of each member, self ratings excluded (PC). */
  normalizedAveragePerceived: number[];
  /** Per student: the team's view scaled to match their own claims. */
  denormalizedAveragePerceived: Matrix;
  /** Ratings each member received from the others; diagonal is NA. */
  normalizedPeerContributionRatio: Matrix;
}

/**
 * Compute the contribution result for one team.
 * @param submissionValues square matrix in roster order, claimed[giver][recipient], NSB where
 *   the giver did not answer, NSU for "Not sure".
 */
export function calculateTeamEvalResult(submissionValues: Matrix): TeamEvalResult {
  const claimed = submissionValues;
  const normalizedClaimed = doubleToIntMatrix(normalizeMatrix(claimed));

  const claimedSanitized = claimed.map((row) => row.map((v) => (v === NSB ? NA : v)));
  const claimedSanitizedNormalized = normalizeMatrix(claimedSanitized);

  const peerContributionRatio = removeSelfRatings(claimedSanitizedNormalized).map(normalizeValues);

  const averagePerceived = averageColumns(peerContributionRatio);
  const normalizedAveragePerceivedAsDouble = normalizeValues(averagePerceived);

  const factor = calculateFactor(averageColumns(peerContributionRatio));
  const normalizedPeerContributionRatio = doubleToIntMatrix(multiplyByFactor(factor, peerContributionRatio));

  const denormalizedAveragePerceived = claimedSanitized.map((row) =>
    calculatePerceivedForStudent(row, normalizedAveragePerceivedAsDouble),
  );

  return {
    claimed,
    normalizedClaimed,
    normalizedAveragePerceived: doubleToInt(normalizedAveragePerceivedAsDouble),
    denormalizedAveragePerceived,
    normalizedPeerContributionRatio,
  };
}

// ---------------------------------------------------------------------------
// Building the matrix and reading results (spec section b, "Outputs")

export interface ContribResponseValue {
  giver_key: string;
  recipient_key: string;
  value: number;
}

/**
 * Square matrix in the order of `memberKeys`, filled with NSB and then with the responses.
 * Responses whose giver or recipient is not in the team are skipped.
 */
export function buildClaimedMatrix(memberKeys: readonly string[], responses: readonly ContribResponseValue[]): Matrix {
  const n = memberKeys.length;
  const index = new Map<string, number>(memberKeys.map((k, i) => [k, i]));
  const m: Matrix = Array.from({ length: n }, () => Array<number>(n).fill(NSB));
  for (const r of responses) {
    const g = index.get(r.giver_key);
    const c = index.get(r.recipient_key);
    if (g === undefined || c === undefined) continue;
    m[g][c] = r.value;
  }
  return m;
}

export interface ContribRow {
  member_key: string;
  /** Normalised claimed figure (CC); can be NSU or NSB. */
  claimed: number;
  /** Perceived figure (PC); NA when nobody rated this member. */
  perceived: number;
  /** perceived - claimed, or NSB (-999) when either is negative. */
  diff: number;
  /** Ratings received from the other members, sorted descending. NA entries are kept. */
  ratings_received: number[];
}

/** One row per member, in the order of `memberKeys`. */
export function contribRows(memberKeys: readonly string[], result: TeamEvalResult): ContribRow[] {
  return memberKeys.map((key, i) => {
    const claimed = result.normalizedClaimed[i][i];
    const perceived = result.normalizedAveragePerceived[i];
    const ratings: number[] = [];
    for (let g = 0; g < result.normalizedPeerContributionRatio.length; g++) {
      if (g !== i) ratings.push(result.normalizedPeerContributionRatio[g][i]);
    }
    ratings.sort((a, b) => b - a);
    return {
      member_key: key,
      claimed,
      perceived,
      diff: claimed < 0 || perceived < 0 ? NSB : perceived - claimed,
      ratings_received: ratings,
    };
  });
}

export interface ContribStudentView {
  /** Raw claimed value of the student for themself. */
  my_claim_of_me: number;
  /** Raw claimed values for the other members, descending. */
  my_claim_of_others: number[];
  /** What the team thinks of the student, scaled to the student's own claims. */
  team_view_of_me: number;
  /** The team's view of the others (scaled the same way), descending. */
  team_view_of_others: number[];
}

/** The per-student view of section 9: `my_claim` and `team_view_of_me`. */
export function contribStudentView(result: TeamEvalResult, index: number): ContribStudentView {
  const mine = result.claimed[index];
  const team = result.denormalizedAveragePerceived[index];
  const others = (row: number[]) => row.filter((_, i) => i !== index).sort((a, b) => b - a);
  return {
    my_claim_of_me: mine[index],
    my_claim_of_others: others(mine),
    team_view_of_me: team[index],
    team_view_of_others: others(team),
  };
}

/** Text for a figure in instructor views: special values become words. */
export function contribPointToText(point: number): string {
  if (point === NSU) return 'Not Sure';
  if (point === NSB) return 'Not Submitted';
  if (point === NA) return 'N/A';
  return String(point);
}
