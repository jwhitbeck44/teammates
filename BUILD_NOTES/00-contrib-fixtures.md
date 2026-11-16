# 00 Contribution fixtures from TeamEvalResultTest

## What was produced

- `/home/claude/peer-feedback/supabase/tests/fixtures/contrib_cases.json`
- `/home/claude/scripts/extract_contrib.py` (parses the Java source as text; run with `python3 -I`)

The script reads `TeamEvalResultTest.java` and `Const.java` as text only. No repository code was executed.

Constants were checked against `Const.java`: `INT_UNINITIALIZED = -9999` (NA), `POINTS_NOT_SUBMITTED = -999` (NSB), `POINTS_NOT_SURE = -101` (NSU). The script stops if these differ.

## Counts

- `cases` (from `testCalculatePoints`, helper `verifyCalculatePoints`): 11
  - Input sizes: 4x4 (x6), 3x3 (x3), 2x2 (x1), 1x1 (x1)
- `other_tests`: 7 tests, 40 cases in total
  - testNormalizeValues: 10
  - testExcludeSelfRatings: 2
  - testAverageColumns: 2
  - testSum: 5
  - testCalculatePerceivedForStudent: 9
  - testIsSanitized: 4
  - testPurgeValuesCorrespondingToSpecialValuesInFilter: 8

## Field mapping for matrix cases

Source: `verifyCalculatePoints` in the test file builds one string from four fields of `TeamEvalResult` and compares it with `pointsToString(expected)`. The expected array is therefore a stack of 3n+1 rows for an n x n input:

| Expected rows | Field | Shape |
|---|---|---|
| 0 .. n-1 | `normalizedClaimed` | n x n |
| n .. 2n-1 | `normalizedPeerContributionRatio` | n x n |
| 2n | `normalizedAveragePerceived` | 1 x n (JSON: flat list) |
| 2n+1 .. 3n | `denormalizedAveragePerceived` | n x n |

The script asserts 3n+1 rows and the row length of each block for every case. All 11 cases pass.

## Other tests

Each other test is stored under `other_tests` with a `name` and a `cases` list. Each case has its own `function` (for example `TeamEvalResult.sum`), an `input` object keyed by the helper's parameter names, and an `expected` value. Parameter names come from the TeamEvalResult signatures:

- normalizeValues, removeSelfRatings, averageColumns, sum: `input`
- calculatePerceivedForStudent: `claimedSanitizedRow`, `normalizedAveragePerceived`
- isSanitized: `array`
- purgeValuesCorrespondingToSpecialValuesInFilter: `filterArray`, `valueArray`

## Issues encountered

1. **Argument order in `verifyNormalized`.** Its signature is `verifyNormalized(double[] expected, double[] input)`, so the expected array comes first. The script maps the arguments that way.
2. **Test-file helpers that compare strings.** `testExcludeSelfRatings` and `testCalculatePerceivedForStudent` compare `pointsToString` or `Arrays.toString` output. The fixture stores the underlying arrays, so the data is the same, but the comparison is not numeric.
3. **Formatting quirk, no effect on the data.** The `normalizedAveragePerceived` row is printed with `Arrays.toString(int[])`, which leaves a raw `-101` unreplaced. No test has NSU in that row, so no case is affected.
4. **Licence string not verified.** The `source` field says `(GPL-2.0)` because the specification says so. The test file header I read (lines 1-19) has no licence text, so the licence should be confirmed before the fixture is published.
5. **Sentinel values are kept as integers.** NA, NSB and NSU appear as -9999, -999 and -101 in the JSON, as specified. Results from `sum` and `purge...` that are NA are stored as -9999 too. A consumer must not treat these as real points.

## Not done

- The script does not re-run the TeamEvalResult algorithm to check the expected values. It only parses and checks dimensions.
