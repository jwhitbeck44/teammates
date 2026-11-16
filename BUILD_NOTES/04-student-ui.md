# 04 Student UI

## Changes made

New files (all under `web/src/`):

- `api/student.ts`: `studentPortal`, `studentGetSession`, `studentSubmit`, `studentGetResults`, `recoverLinks(email)`. Failures throw `StudentApiError` (`code`, human `message`, `recipient_key`). Types are re-exported from `lib/studentTypes.ts`.
- `lib/studentTypes.ts` (new lib file, kept apart so tests do not import the network client): payload types, including `StudentSessionPayload` and the discriminated `PayloadQuestion`.
- `lib/studentView.ts` (new lib file): `mapRpcError`, `effectiveStatus`, `timeLeftText`, `groupResults`, `resultRowTitle`, `contribFigureText`, `contribSummaryLines`.
- `components/answer/`: `mapping.ts` (pure value mapping), `draft.ts` (pure question state: chosen recipients, rows to send, dirty signature), one input per type (`TextInput`, `McqInput`, `MsqInput`, `NumscaleInput`, `ConstsumOptionsInput`, `ConstsumRecipientInput`, `ContribInput`, `RubricInput`, `RankOptionsInput`, `RankRecipientInput`), `AnswerField` (dispatcher), `RecipientPicker` (max_recipients).
- `components/submission/`: `SubmissionForm.tsx`, `QuestionBlock.tsx`.
- `components/common/`: `ErrorMessage`, `Loading`, `TimeText`, `Page`, `useNow`, `useLoad`.
- `pages/student/`: `StudentPortal`, `StudentSubmit`, `StudentResults`, `InvalidLink`; `pages/Recover.tsx`.
- `styles/base.css`, imported from `main.tsx` (one added line).
- Tests: `components/answer/mapping.test.ts`, `draft.test.ts`, `components/submission/SubmissionForm.test.ts` (server-side render of all 10 types, no jsdom), `lib/studentView.test.ts`. 71 new tests; the whole suite passes (331).

No existing lib file was edited.

## SubmissionForm props as built

```ts
interface SubmissionFormProps {
  payload: StudentSessionPayload;   // from api/student (also lib/studentTypes)
  readOnly?: boolean;
  onSaveQuestion?: (questionId: string,
    answers: { recipient_key: string; answer: unknown; giver_comment?: string | null }[]) => Promise<void>;
  banner?: ReactNode;               // rendered at the top of the form, above the instructions
}
```
`export default SubmissionForm` and `export { SubmissionForm }` from `components/submission/SubmissionForm.tsx` (also `components/submission/index.ts`).

For the instructor agent:
- `onSaveQuestion` must resolve on success and throw on failure. Throw anything `mapRpcError` understands (a supabase error object, an `Error`, or a `StudentApiError`); the form shows the mapped text next to the question and, if `details` holds a recipient key, next to that row. Call `mapRpcError(error)` yourself if you want the same text elsewhere.
- Without `onSaveQuestion`, or with `readOnly`, there are no Save buttons and inputs are disabled.
- `payload.student` is optional, so `instructor_get_submission` output (which has `instructor` instead) and `instructor_preview` output both fit. `student` is only used to label the student's own row "(you)".
- State is created once from `payload` at mount. To load a different payload, change the `key` of the form. After a save the form keeps its own state and does not need a refetch.
- Moderation: the form sends only rows with a non-blank answer, so clearing a question sends `[]` (the RPCs delete the giver's rows for it).
- `QuestionBlock`, `AnswerField`, `mapping.ts` and `draft.ts` can be reused.

## Decisions

- **Blank rows are not sent.** A row with no answer is omitted. For `constsum_options` and `rank_options` an untouched row is omitted, but once anything is typed, blank option boxes count as 0 (constsum) or "No rank" (rank). For `constsum_recipients`, a blank box means "skip this recipient", so the pool is `points x answered rows` when `pointsPerOption` (matches SQL). Type 0 for an explicit zero.
- **MSQ always offers "None of the above"** (sends `{choices: []}`); an untouched MSQ sends nothing.
- **Contrib** zero-sum total is shown as "Total: N. Needs to be 100 x size." in raw points next to the "Equal share" wording, because the server checks raw points.
- **Text is trimmed** before sending; MCQ "Other" with an empty text is sent as `{other: ''}` so validation reports `empty_other` rather than dropping the row.
- **Giver comments** have no input. A saved `giver_comment` is passed through unchanged on re-save.
- **Deadline shown to students is `deadline`** (the server's value: extension or `closes_at + grace`), as "Deadline", because that is the moment saving stops. The submit page never locks inputs from the device clock (clocks drift); it only shows a note and lets the server answer. It locks when the session loads as `closed` or the server returns `deadline_passed`.
- **Results grouping:** own answers first ("You gave", so a self rating lands there), then answers whose recipient is the student or their team ("About you"), then "Others". Names come from the server; "Anonymous" is shown as received.
- **Recover:** always shows the same confirmation after the function answers. A network failure or a 5xx shows an error instead, since saying "sent" then would be false. 4xx, including rate limit, shows the confirmation.
- Rubric is a grid of radio cells (one fieldset per sub-question). It stays a grid at 40rem and wider and stacks on phones. Not a `<table>`.
- No jsdom or Testing Library was added; render checks use `react-dom/server`.

## Deviations and gaps

1. **Visibility lists are not in `student_get_session`.** `build_questions` returns no `show_responses_to / show_giver_name_to / show_recipient_name_to`, so the "Who can see your answer" line cannot be shown for students yet. The form shows it whenever the three lists are present on a question (the types allow them as optional). Fix needed in SQL (a new migration with `create or replace function public.build_questions`, adding `'show_responses_to', q.show_responses_to, 'show_giver_name_to', q.show_giver_name_to, 'show_recipient_name_to', q.show_recipient_name_to` to the question object). Whoever owns the database layer should do it and add a test; the instructor path (`instructor_get_submission`, `instructor_preview`) shares `build_questions`, so one change covers all.
2. `errors.ts` lacks `last_coowner`, `invalid_time_zone`, `name_taken`, `already_published` (see 01-database.md item 7). Not needed for student pages; they would show the generic text.
3. `npm run typecheck` currently fails on `src/components/instructor/questions/draft.test.ts(29,57)` (`recommendedLength` on `ConstsumOptionsDetails`). That file belongs to the instructor agent. With it excluded, my files typecheck, all tests pass and `vite build` succeeds.

## Notes for the end-to-end tester

- Routes: `/#/s/<token>`, `/#/s/<token>/sessions/<id>`, `/#/s/<token>/results/<id>`, `/#/recover`.
- Check at 360px: rubric stacks, the sticky "Save all" bar stays in reach, number boxes are 16px so iOS does not zoom.
- Try: contrib zero-sum with a wrong total (client message, then fix), `max_recipients` picker at the cap, saving after the deadline (form turns read only with "Closed"), invalid token (friendly page with link to `/recover`), unpublished results (friendly page).
- Unsaved-changes warning uses `beforeunload`; in-app navigation (the "Back" link) does not warn.
