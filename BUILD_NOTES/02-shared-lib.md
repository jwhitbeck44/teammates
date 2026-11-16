# 02 Shared lib and web scaffold

## Changes made

State found: Vite/React scaffold, route placeholders, and in `web/src/lib/` the files types, errors, validation, recipients, visibility, contrib and contrib.test. `npm test` passed (58 tests) but `npm run build` failed: `contrib.test.ts` uses `node:fs`, and the app `tsconfig.json` has no Node types.

Fixed:
- `web/tsconfig.json` now excludes `src/**/*.test.ts`. New `web/tsconfig.test.json` extends it, adds Node types, and covers tests plus `src/lib`. The `typecheck` script runs all three configs. Reason: app code must not see Node APIs (the lib stays browser-safe), while tests may read the fixture file.
- `visibility.ts` `describeVisibility()` wording was ungrammatical ("can see the response, sees the giver's name"). Now: "Recipient can see the response, the recipient's name, but not the giver's name."

`contrib.ts` needed no change. It passes all 11 matrix cases and all 40 helper cases of `supabase/tests/fixtures/contrib_cases.json` (every function in `other_tests` has a matching export; a test asserts the fixture's function list).

Built (all in `web/src/lib/`): `stats.ts`, `csv.ts`, `templates.ts`, `time.ts`, `answerText.ts`, plus `test-helpers.ts` (builders for tests, not imported by app code) and tests for every module: `validation.test.ts`, `recipients.test.ts`, `visibility.test.ts`, `stats.test.ts`, `csv.test.ts`, `templates.test.ts`, `time.test.ts`, `answerText.test.ts` (with the existing `contrib.test.ts`). 260 tests in 9 files; `npm run typecheck`, `npm test` and `npm run build` pass.

## Public API (new modules)

Instants are `string | Date | number`. Everything is pure and uses only `Intl`, `Date`, `Map` and so on.

### answerText.ts
- `answerText(question: {type, details}, answer: unknown): string` one-line text per type; malformed answers give `''`; MSQ with no pick gives "None of the above".
- `contribValueText(value: number): string` "Equal share + N%", "Equal share", "Equal share - N%", "0%", "Not Sure".
- `numberText(value): string` (three decimals, no trailing zeros), `alphabeticalIndex(n): string` (1 to a), constants `NO_RESPONSE_TEXT`, `NONE_OF_THE_ABOVE_TEXT`.

### stats.ts
Input: `StatResponse {giver_key, recipient: StatRecipient {key, name, email, team, team_key?, kind}, answer}`.
- `numscaleStats(responses)`, `choiceStats(details, responses)` (mcq and msq), `constsumOptionsStats(details, responses)`, `constsumRecipientsStats(responses)`, `rubricStats(details, responses)`, `rankOptionsStats(details, responses)`, `rankRecipientsStats(responses)`, `contribStats(teams: ContribTeam[], values: ContribValueResponse[])`.
- `questionStats(type, details, responses, contribTeams?): QuestionStats | null` dispatcher (null for text), result tagged by `kind`.
- Helpers: `round2`, `normalizeRanks(ranks)`, `computeOverallRanks(map)`.

### csv.ts
- `toCsv(rows, {neutralize?})`, `parseCsv(text, delimiter?)`, `neutralizeFormula(cell)`.
- `parseRosterCsv(text, {existing?}): {rows, valid, errors: RowError[], hadHeader}`, `buildRosterCsv(students)`.
- `studentLink(appUrl, token)`, `buildStudentLinksCsv(students, appUrl)`, `buildNonSubmitterCsv(students)`.
- `buildResultsCsv(questions: ResultsQuestion[], {includeStats?, indicateMissing?, sectionName?, sectionDetail?})`, `answerColumnHeaders(type, details)`, `answerCells(type, details, answer)`, `statsRows(stats)`.

### templates.ts
- `getTemplate(id): SessionTemplate`, `listTemplates()`, `TEMPLATE_IDS`; ids `point_based | percentage_based | empty`. Fresh objects on every call.

### time.ts
- `formatInstant(instant, tz, {weekday?, zoneName?})`, `instantToLocalParts`, `instantToLocalInputs` (`{date, time}`), `localToInstant(date, time, tz): Date | null`, `isValidTimeZone`.
- `sessionStatus(session, now)`, `studentStatus(session, now, extension?)`, `studentDeadline(session, extension?)` (ms), `canStudentSubmit(session, now, extension?)`, `graceEnd`, `isPublished(session, now)`, `validateExtension(session, extension)`, `timeUntil(target, now)`, `toMs`.

## Decisions not covered by ARCHITECTURE.md

- Statistics follow the TEAMMATES calculators: two-decimal rounding with Java `Math.round` semantics, averages excluding self when giver key equals recipient key, rows ordered by recipient team then name by plain code point comparison, recipient-based tables skip the `none` recipient. Rank options compact each response to dense ranks first; rank recipients do not (as in Java). Ties share a rank and the next rank skips (1, 1, 3). Rank in team is computed for student recipients only, grouped by `team_key` (falls back to team name), so two same-named teams in different sections stay separate.
- MCQ and MSQ weights are not built, so MCQ, MSQ and rubric statistics are the unweighted tables. MSQ percentages are over all picks, as in TEAMMATES. "Other" is a row labelled `Other`.
- Contrib statistics rows come from `contrib.ts` (`calculateTeamEvalResult` and `contribRows`) per team. Members who never answered or were never rated still get a row (claimed -999). The results CSV takes members from the responses plus an optional `contribMembers` list.
- Results CSV: header and per-type columns as in spec section k. MSQ answer rows put the "other" text in the `Feedback` column and the picked choices in one column per listed choice (TEAMMATES leaves "other" out). Instructor comment columns are not built (comments are not built). Every cell is made formula-safe (leading `'` before `= + @` and before `-` that is not a number), because student-written text goes into the file. The links CSV and non-submitter CSV do the same. `toCsv` without `neutralize` is exact RFC 4180.
- Results CSV takes missing responses as rows with `answer: null`. Computing which responses are missing (giver by resolved recipient) is left to the page that calls it.
- Roster parsing: the first row is a header when it holds both `name` and `email` (any case); a header may reorder columns or omit Section, Team and Comments. Tab-separated paste is detected from the first line. Blank rows are skipped but counted in row numbers. Section and team names have inner whitespace squashed; email is lowercased. Duplicate email: the second and later rows are flagged. Section size: counts `existing` students whose email is not in the input, and flags the rows that go past 100. A header missing Name or Email is reported on row 0. A non-empty cell beyond column five gives `wrong_column_count`.
- Templates keep TEAMMATES' question text, types, paths, descriptions and visibility exactly. Default session names are TEAMMATES' ("session using template: ..."); labels are the capitalised names in ARCHITECTURE.md.
- `studentStatus` with an extension: `open` until the extension time, then `closed` (no grace added on top).
- `formatInstant` uses the `en-US` locale and the runtime's zone abbreviation.

## Deviations

- Templates drop TEAMMATES' long `questionText` field and `shouldAllowRichText`. This app's question shape has only `brief` and `description` and plain text only (ARCHITECTURE.md section 3). In both templates the brief already contains the text.
- Student deadline follows ARCHITECTURE.md section 5 (extension replaces `closes_at + grace`). TEAMMATES uses `max(extension, end + grace)` (spec section f). The two differ only when an extension is shorter than the grace period, which `validateExtension` allows (extension must only be later than `closes_at`). See open issues.

## Issues encountered and open items

1. Extension shorter than grace: a student with a 5 minute extension and a 15 minute grace period gets a shorter deadline than everyone else under the ARCHITECTURE.md rule. SQL `student_deadline()` must match whichever rule is chosen; the TS follows ARCHITECTURE.md. A simple fix is `greatest(extension, closes_at + grace)` in both places; I did not change it because ARCHITECTURE.md is the contract.
2. `validateAnswers` for `rank_options` rejects an answer with no ranked option (`too_few_ranked`) while an empty submission (no rows) is valid. That matches "blank answers skip the question" only if the UI sends no row for an untouched question. SQL must do the same.
3. `describeVisibility` text changed; nothing else used its old wording.
4. Node 22 Intl data is assumed for tests that check zone abbreviations ("MST"); browsers give the same for `en-US` and American zones, but other zones may show "GMT+1" style names.
5. Not built here and needed by the results pages: a helper that lists missing responses per giver, and a ready-made mapping from `responses` rows plus roster to `StatResponse`/`ResultsQuestion`. These belong with the `api/` and page code.
6. The fixture `source` licence string (see 00-contrib-fixtures.md issue 4) is still unverified.
