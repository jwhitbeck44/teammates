# TEAMMATES peer feedback: feature spec derived from code

Source: shallow clone of github.com/TEAMMATES/teammates at /home/claude/ref/teammates (read only, nothing run). Paths below are relative to `src/`. Backend is Java (`main/java/teammates/...`), frontend is Angular (`web/...`).

## a. Question types

Enum: `common/datatransfer/questions/FeedbackQuestionType.java`. Values: `TEXT, MCQ, MSQ, NUMSCALE, CONSTSUM_OPTIONS, CONSTSUM_RECIPIENTS, CONTRIB, RUBRIC, RANK_OPTIONS, RANK_RECIPIENTS`. Each has a `Feedback<X>QuestionDetails` and `Feedback<X>ResponseDetails` class in the same folder. Every question also has: questionNumber, questionBrief (required, non-empty), questionDescription, giverType, recipientType, numberOfEntitiesToGiveFeedbackToSetting (`CUSTOM` with a count, or `UNLIMITED`), and three visibility lists (section d). Every response also has an optional `giverComment` (`FeedbackResponse.java`).

Changing some settings deletes existing responses (`shouldChangesRequireResponseDeletion` in each details class: changed choices, scale, points, options, rich-text turned off, etc.).

Statistics: `logic/statistics/*QuestionStatisticsCalculator.java`, wired in `FeedbackQuestionResultsStatisticsFactory.java`. Each has a course-wide view (instructor) and a per-recipient view. TEXT has none.

| Type | Giver enters | Config and validation | Instructor statistics |
|---|---|---|---|
| TEXT | Free text, rich text by default | `recommendedLength` (optional, must be >= 1, shown not enforced), `shouldAllowRichText` (default true) | None |
| MCQ | One choice, optionally an "other" free-text choice | `mcqChoices` (min 2, no blanks, no duplicates), `otherEnabled`, `questionDropdownEnabled`, `generateOptionsFor` (`NONE`, `STUDENTS`, `STUDENTS_EXCLUDING_SELF`, `TEAMS`, `TEAMS_EXCLUDING_SELF`, `OWN_TEAM_MEMBERS_INCLUDING_SELF`, `OWN_TEAM_MEMBERS`, `INSTRUCTORS`; when not NONE the choices are generated from that list), `hasAssignedWeights`, `mcqWeights` (non-negative, 2 decimals), `mcqOtherWeight`. Answer must be a listed choice, "other" needs text | Per option: count, percentage, weight, weightedPercentage. If weighted, per-recipient rows with per-option counts, total, average |
| MSQ | One or more choices, optional "other", or "none of the above" (empty answer, no other choice allowed with it) | Same as MCQ plus `maxSelectableChoices` (>= 2, <= number of options) and `minSelectableChoices` (>= 1, <= options, <= max); both default to `Const.POINTS_NO_VALUE` (off). Weights may be any number | Same as MCQ |
| NUMSCALE | One number | `minScale` (default 1), `maxScale` (default 5), `step` (default 0.5). Need min < max and step > 0. Answer must be in range and equal to min + k*step | Per recipient: average, min, max, average excluding self (self rows only when giver is recipient). Rounded to 2 decimals |
| CONSTSUM_OPTIONS | Integer points per listed option | `constSumOptions` (min 2, unique), `points` (default 100, min 1), `pointsPerOption` (true means total = points x number of options), `forceUnevenDistribution`, `distributePointsFor` (`"None"`, `"At least some options"`, `"All options"`), optional `minPoint`/`maxPoint` (0..total, min <= floor(total/n), max >= ceil(total/n), min <= max). Answers: no negatives, sum equals total exactly, within min/max. "Some unevenly" means at least two different values; "All options" or `forceUnevenDistribution` means all values distinct. Blank boxes skip the question | Per option: total points, average points, list of points received |
| CONSTSUM_RECIPIENTS | One integer per recipient, shared pool across the giver's recipients | `points` (default 100, min 1), `pointsPerOption` (true means total = points x number of recipients), `forceUnevenDistribution`, `distributePointsFor`. Same sum and uniqueness rules as above | Per recipient: points received, total, average, average excluding self |
| CONTRIB | Per team member (including self): 0 to 200 in steps of 5 where 100 = "Equal share", or "Not sure" (-101) | `isZeroSum` (default true), `isNotSureAllowed` (default false); both true is invalid. Zero-sum requires answers to sum to team size x 100. Not zero-sum allows an unanswered row (-999). Path is forced to STUDENTS to `OWN_TEAM_MEMBERS_INCLUDING_SELF`; RECIPIENT and GIVER_TEAM_MEMBERS visibility must be set together; instructor comments on responses are disabled; individual responses are not shown to students | Section b |
| RUBRIC | One choice per sub-question (a grid), -1 = not chosen; at least one sub-question must be answered | `rubricChoices` (min 2, blanks allowed), `rubricSubQuestions` (min 1, non-blank), `rubricDescriptions` (grid, sub-questions x choices), `hasAssignedWeights`, `rubricWeightsForEachCell` (grid of numbers, 2 decimals) | Per sub-question row: count and percentage per choice, weighted average if weights. Without weights the same table excluding self. For weighted, per-recipient rows with per-criterion averages, overall total and average |
| RANK_OPTIONS | A rank (1..number of options) per listed option; blanks allowed | `options` (min 2, no blanks), `minOptionsToBeRanked`, `maxOptionsToBeRanked` (off by default, 1..options, min <= max), `areDuplicatesAllowed` (default false). Rank must be 1..number of options | Per option: ranks received (sorted) and overall rank. Ranks are first compacted to dense ranks per response, then options are ordered by average rank; ties share a rank |
| RANK_RECIPIENTS | A rank per recipient | Same min/max/duplicates settings, no options list. Rank must be 1..number of recipients | Per recipient: ranks received, self rank, overall rank, rank excluding self, rank in team, rank in team excluding self. No per-recipient view |

Allowed feedback paths by type are in section c. `FeedbackConstantSumQuestionDetailsHelper` (`common/util/`) holds the points validation and error strings.

## b. CONTRIB calculation

Class `common/datatransfer/TeamEvalResult.java`, called by `logic/statistics/FeedbackContributionQuestionStatisticsCalculator.java`. Constants (`common/util/Const.java`): equal share 100, `NSU` = -101 (not sure), `NSB` = -999 (not submitted), `NA` = -9999.

Input per team: square int matrix `claimed[giver][recipient]` in roster order, initialised to NSB and filled from responses (skipping responses whose giver or recipient is not in the team).

Helper definitions:
- Special values: NA, NSU, NSB.
- `normalize(row)`: over non-special entries, `factor = (count x 100) / sum`, or 0 if sum is 0. Multiply every non-special entry by factor (unchanged if factor is 0). Special entries stay as they are.

Steps:
1. `normalizedClaimed = round(normalize(row))` for each row of the raw matrix. Diagonal `normalizedClaimed[i][i]` is the "claimed" figure (CC) shown to instructors.
2. `claimedSanitized` = raw matrix with NSB replaced by NA (NSU stays).
3. Normalize each row of `claimedSanitized` (doubles, not rounded).
4. Peer ratio: set the diagonal to NA, then normalize each row again. This gives `peerContributionRatio`, each giver's ratings of others rescaled to average 100.
5. `averagePerceived[j]` = mean of column j of the peer ratio, skipping NA and NSU. NA if nothing is left.
6. `normalizedAveragePerceived = round(normalize(averagePerceived))`. This is the "perceived" figure (PC) shown to instructors. It excludes self ratings.
7. `normalizedPeerContributionRatio` (the per-giver ratings received): take the column means of the peer ratio, compute `factor = (count x 100) / sum(means)`, multiply every cell of the peer ratio by factor, round.
8. `denormalizedAveragePerceived` (what student k sees as the team's view): for giver k, keep only positions where k's sanitized claim is valid and where perceived is valid; `sumPerceived` = sum of perceived at those positions, `sumActual` = sum of k's claims at those positions. If k submitted nothing, `sumActual = sumPerceived`. `factor = sumActual / sumPerceived`; result = round(`normalizedAveragePerceived` x factor), special values preserved.

Outputs: course-wide row per student = team, name, email, `claimed` = `normalizedClaimed[i][i]`, `perceived` = `normalizedAveragePerceived[i]`, `diff` = perceived - claimed (or -999 if either is negative), `ratingsReceived` = `normalizedPeerContributionRatio[g][i]` for g != i, sorted descending. Per-student view: "of me" and "of others" from raw `claimed[i]` (others sorted descending) and from `denormalizedAveragePerceived[i]`. Per-response normalized value: self response uses `normalizedClaimed`, others use `normalizedPeerContributionRatio`.

Display text for raw answers (`web/types/response-details-impl/feedback-contribution-response-details.impl.ts`): >100 "Equal share + N%", 100 "Equal share", 1..99 "Equal share - N%", 0 "0%", -101 "Not Sure".

## c. Feedback paths

Giver types (`common/datatransfer/participanttypes/QuestionGiverType.java`): `SESSION_CREATOR, STUDENTS, INSTRUCTORS, TEAMS`.
Recipient types (`QuestionRecipientType.java`): `SELF, STUDENTS, STUDENTS_IN_SAME_SECTION, STUDENTS_EXCLUDING_SELF, INSTRUCTORS, TEAMS, TEAMS_IN_SAME_SECTION, TEAMS_EXCLUDING_SELF, OWN_TEAM, OWN_TEAM_MEMBERS, OWN_TEAM_MEMBERS_INCLUDING_SELF, NONE`.

Allowed combinations (`web/services/feedback-questions.service.ts`, `getAllowedFeedbackPaths`; the backend only enforces CONTRIB in `validateGiverRecipientVisibility`):
- CONTRIB: STUDENTS to `OWN_TEAM_MEMBERS_INCLUDING_SELF` only.
- TEXT, MCQ, MSQ, NUMSCALE, RANK_OPTIONS, RUBRIC, CONSTSUM_OPTIONS:
  - SESSION_CREATOR: SELF, STUDENTS, INSTRUCTORS, TEAMS, NONE
  - STUDENTS: SELF, STUDENTS, STUDENTS_EXCLUDING_SELF, STUDENTS_IN_SAME_SECTION, INSTRUCTORS, TEAMS, TEAMS_EXCLUDING_SELF, TEAMS_IN_SAME_SECTION, OWN_TEAM, OWN_TEAM_MEMBERS, OWN_TEAM_MEMBERS_INCLUDING_SELF, NONE
  - INSTRUCTORS: SELF, STUDENTS, INSTRUCTORS, TEAMS, NONE
  - TEAMS: SELF, STUDENTS, INSTRUCTORS, TEAMS, TEAMS_EXCLUDING_SELF, TEAMS_IN_SAME_SECTION, NONE
- RANK_RECIPIENTS, CONSTSUM_RECIPIENTS (no SELF, OWN_TEAM, NONE):
  - SESSION_CREATOR and INSTRUCTORS: STUDENTS, INSTRUCTORS, TEAMS
  - STUDENTS: STUDENTS, STUDENTS_EXCLUDING_SELF, STUDENTS_IN_SAME_SECTION, INSTRUCTORS, TEAMS, TEAMS_EXCLUDING_SELF, TEAMS_IN_SAME_SECTION, OWN_TEAM_MEMBERS, OWN_TEAM_MEMBERS_INCLUDING_SELF
  - TEAMS: STUDENTS, STUDENTS_IN_SAME_SECTION, INSTRUCTORS, TEAMS, TEAMS_EXCLUDING_SELF, TEAMS_IN_SAME_SECTION

`NumberOfEntitiesToGiveFeedbackToSetting` is `CUSTOM` (with `customNumberOfEntitiesToGiveFeedbackTo`) or `UNLIMITED`; it limits how many recipients each giver answers for.

## d. Visibility

Enum `FeedbackVisibilityType`: `RECIPIENT, GIVER_TEAM_MEMBERS, RECIPIENT_TEAM_MEMBERS, STUDENTS, INSTRUCTORS`. Three separate lists per question: `showResponsesTo`, `showGiverNameTo`, `showRecipientNameTo` (`ui/request/FeedbackQuestionBasicRequest.java`, all required, may be empty). UI rules in `web/services/visibility-state-machine.ts`:
- Giving name visibility to a type also grants response visibility. Removing response visibility removes both name rights.
- Recipient always sees recipient name when seeing the response (not editable).
- Hidden as redundant: GIVER_TEAM_MEMBERS for instructor/creator/team givers; RECIPIENT for SELF, OWN_TEAM, NONE; RECIPIENT_TEAM_MEMBERS for SELF, INSTRUCTORS, teams, own team options, NONE, and instructor-to-self; RECIPIENT for TEAMS giver to OWN_TEAM_MEMBERS_INCLUDING_SELF.
- Presets (`feedback-questions.service.ts`, `getCommonFeedbackVisibilitySettings`): CONTRIB has "Shown anonymously to recipient and giver's team members, visible to instructors" (responses: instructors, recipient, giver team; giver name: instructors; recipient name: instructors, recipient) and "Visible to instructors only". Other types add "Shown anonymously to recipient and instructors", "Shown anonymously to recipient, visible to instructors", two team-member variants, and instructors only. The rest of the list was not read.
- Anonymous names display as "Anonymous" (`Const.DISPLAYED_NAME_FOR_ANONYMOUS_PARTICIPANT`).
- Default for a new question: not determined from code read (see Issues).

## e. Session templates

File: `web/data/template-sessions.ts`. Templates: "team peer feedback (point-based)", "team peer feedback (percentage-based)", "session with my own questions" (empty). All questions: giver STUDENTS, numberOfEntities UNLIMITED (custom value 1 unused), text answers rich text. Visibility abbreviations: I = INSTRUCTORS, R = RECIPIENT, GTM = GIVER_TEAM_MEMBERS. Format: showResponsesTo / showGiverNameTo / showRecipientNameTo.

Point-based:
1. Type `CONSTSUM_RECIPIENTS` (pointsPerOption true, points 100, forceUnevenDistribution false, distributePointsFor "None"). Recipient `OWN_TEAM_MEMBERS_INCLUDING_SELF`. Brief: "How much work did each team member contribute? (response will be shown anonymously to each team member). " Description: "If a team member did an equal share of the work, give 100 points. If a team member did about 10% more than an equal share of the work, give 110 points, and so on." questionText: "How much work did each team member contribute?" Visibility: I,R,GTM / I / I,R.
2. `TEXT`, recipient `SELF`. "What contributions did you make to the team? (response will be shown to each team member)." Visibility: R,GTM,I / R,GTM,I / R,GTM,I.
3. `TEXT`, recipient `OWN_TEAM_MEMBERS`. "What comments do you have regarding each of your team members? (response is confidential and will only be shown to the instructor)." Visibility: I / I / I.
4. `TEXT`, recipient `OWN_TEAM`. "How are the team dynamics thus far? (response is confidential and will only be to the instructor)." (typo is in source). Visibility: I / I / I.
5. `TEXT`, recipient `OWN_TEAM_MEMBERS`. "What feedback do you have for each of your team members? (response will be shown anonymously to each team member)." Visibility: R,I / I / R,I.

Percentage-based: identical questions 2 to 5 (same text, types, paths, visibility). Question 1 differs: type `CONTRIB` (isZeroSum true, isNotSureAllowed false), recipient `OWN_TEAM_MEMBERS_INCLUDING_SELF`, same brief, empty description, questionText "How much work did each team member contribute?", visibility I,R,GTM / I / I,R.

Question text lives in `questionBrief` (short, shown in lists) and `questionDetails.questionText` (long); for TEXT the latter is empty in templates.

## f. Session settings

Entity `storage/entity/FeedbackSession.java`; request `ui/request/FeedbackSessionBasicRequest.java`. Name unique per course, max 64 chars, no `|` or `%`.
- `instructions` (rich text), `submissionStartTimestamp` (open time), `submissionEndTimestamp` (close time), `gracePeriod` (UI options 0,5,10,15,20,25,30 minutes; must be non-negative), `responseVisibleSetting`, `customResponseVisibleTimestamp`, `isClosingSoonEmailEnabled`, `isPublishedEmailEnabled`.
- Session visible from: there is no separate field. The session becomes visible at open time (`isVisible() = !isWaitingToOpen()`). The UI text says so.
- Results visible: `ResponseVisibleSetting` `CUSTOM` (stored timestamp), `AT_VISIBLE` (stored as sentinel `TIME_REPRESENTS_FOLLOW_VISIBLE`, published when session opens), `LATER` (sentinel `TIME_REPRESENTS_LATER`, manual publish). Manual publish stores sentinel `TIME_REPRESENTS_NOW`, unpublish resets to LATER and clears `isPublishedEmailSent`. Sentinels are 1970 dates in `Const.java`. Publish and unpublish need `canmodifysession`.
- States: open when start <= now < end; grace when end < now <= end + grace; closed after end + grace. Submission status enum `NOT_VISIBLE, OPEN, GRACE_PERIOD, CLOSED`.
- Validation (`FieldValidator.java`): end after start; start not earlier than about 2 hours ago, end not earlier than about 1 hour ago, both within 12 months ahead; extended deadlines must be after session end.
- Time zone: stored on the course (`Course.timeZone`, default `UTC`). Times are stored as UTC instants and shown in the course time zone. Default edit-form close time is 23:59 (`session-edit-form.component.ts`).
- Deadline extensions (`storage/entity/DeadlineExtension.java`, `logic/core/DeadlineExtensionsLogic.java`): one row per (user, session) with its own `endTime`, for students or instructors. User deadline = extension end time or session end time. A user can submit until `max(extended deadline, session end + grace)`; grace applies only to the session end. Update request returns CREATED, UPDATED, UNCHANGED or DELETED per user. A `notifyAboutDeadlines` flag decides whether emails go out. Needs `canmodifysession`.
- Sessions can be soft-deleted (`deletedAt`, recycle bin) and restored.

## g. Emails

Types: `common/util/EmailType.java`. Scheduling: cron endpoints under `/auto/` in `ui/webapi/ActionFactory.java`, documented in `docs/cron-setup.md` (hourly, UTC, bearer secret). Queries in `storage/api/FeedbackSessionsDb.java`; sending in `logic/core/FeedbackSessionsLogic.java`. Each automated email has an "already sent" flag on the session so it is sent once.

| Email | Trigger | Recipients | Setting |
|---|---|---|---|
| FEEDBACK_OPENING_SOON | Start time within next 24h (2h catch-up window), not yet sent | Co-owner instructors | Always on |
| FEEDBACK_OPENED | Started within last 2 days, still open, not sent | Students and instructors who have questions in the session, plus preview copies to co-owners | Always on (checkbox shown checked and disabled) |
| FEEDBACK_CLOSING_SOON | End time within next 24h (2h window), session is open, not sent, session length over 24h | Students and instructors without a deadline extension (extension holders get their own copy 24h before their own deadline), plus preview to co-owners | `isClosingSoonEmailEnabled` |
| FEEDBACK_CLOSED | Ended within last 2 days, not sent (the Db query also requires `isClosingSoonEmailEnabled`) | Co-owner instructors, with link to the report | `isClosingSoonEmailEnabled` (as coded) |
| FEEDBACK_PUBLISHED | Automatic: custom publish time reached within last 2 days, not sent. Manual: sent immediately on publish | Students and instructors, plus preview to co-owners | `isPublishedEmailEnabled` |
| FEEDBACK_UNPUBLISHED | On manual unpublish | Same as published | `isPublishedEmailEnabled` |
| FEEDBACK_SESSION_REMINDER | Instructor picks users to remind (session must be open) | Chosen students/instructors, optional copy to instructor | Manual |
| Results reminder | Instructor picks users (session must be published) | Chosen users | Manual |
| DEADLINE_EXTENSION_GRANTED, _UPDATED, _REVOKED | On extension create, change, delete | The affected user | `notifyAboutDeadlines` flag on the request |
| SESSION_LINKS_RECOVERY | Public form with email and reCAPTCHA | The email address; lists links for that student's sessions in the last 180 days that are open, closed or published; sent even when email not found (separate template) | Always |
| STUDENT_COURSE_JOIN, INSTRUCTOR_COURSE_JOIN | Invite or reminder, manual | Student or instructor | Manual |
| USER_COURSE_REGISTER | After a user joins with an account | The user | Always |
| STUDENT_EMAIL_CHANGED, *_COURSE_LINKS_REGENERATED | Email change, link regeneration (admin) | The user | Always |

Other types exist for account verification and login (`ACCOUNT_VERIFICATION_*`, `NEW_ACCOUNT_VERIFICATION_REQUEST_*`, `LOGIN`, `*_REJOIN_AFTER_UNLINK_ACCOUNT`). Email templates are HTML files in `main/resources/*EmailTemplate-*.html`.

## h. Student access

- Each user has `linkVersion`. A session link carries an encrypted key `SessionKey(userId, type, linkVersion, feedbackSessionId)` with `type` of `SUBMISSION` or `RESULTS` (`common/util/KeyUtil.java`). Course join links use `CourseJoinKey(userId, linkVersion)`. Bumping `linkVersion` invalidates old links (`UsersLogic`, regenerate action is admin only).
- `AuthLogic.getSessionKeyAccessResult` decisions: `ALLOW_UNREGISTERED` (student has no linked account, so the key alone grants access, no login), `ALLOW_SIGNED_IN`, `SIGN_IN_REQUIRED` (student has an account but nobody is signed in), `SIGN_IN_WITH_ANOTHER_ACCOUNT`, `INVALID_KEY`.
- Join: `CourseJoinKeyAccessDecision` is `VALID`, `ALREADY_JOINED`, `SIGN_IN_REQUIRED`, `INVALID_KEY`. `JoinCourseAction` and `LinkAccountAction` link a Google account to the student record and send USER_COURSE_REGISTER. After linking, the old key links require sign-in, and the student gets dashboard endpoints (`GetStudentCoursesAction`, `GetStudentFeedbackSessionsAction`). Instructors cannot use keys and always need an account.

## i. Instructor roles

Roles (`InstructorPermissionRole`): `COOWNER, MANAGER, OBSERVER, TUTOR, CUSTOM` (default privileges in `DefaultInstructorPrivileges.java`). Permission names (`Const.InstructorPermissions`): `canmodifycourse`, `canmodifyinstructor`, `canmodifysession`, `canmodifystudent`, `canviewsession`, `cansubmitsession`.

| Role | modifycourse | modifyinstructor | modifysession | modifystudent | viewsession | submitsession |
|---|---|---|---|---|---|---|
| Co-owner | yes | yes | yes | yes | yes | yes |
| Manager | no | yes | yes | yes | yes | yes |
| Observer | no | no | no | no | yes | no |
| Tutor | no | no | no | no | yes | yes |
| Custom | no | no | no | no | no | no |

Meaning: modifycourse (edit, delete or restore course), modifyinstructor (add, edit instructors; view session logs), modifysession (create, edit, delete, publish sessions and questions, extensions, moderate or preview as a user), modifystudent (enroll, edit, delete students, send invites), viewsession (see results), cansubmitsession (submit as instructor, add instructor comments on responses).

Levels: course level holds all six. Section level and session level overrides exist only for `canviewsession` and `cansubmitsession` (`InstructorPrivileges.java`; section-level-only list is empty, and the other four are course level only in this code). Lookup order: session within section, then section, then course. `InstructorSectionPrivilege.java` and `InstructorSessionPrivilege.java` are the entities. Moderation of a student is checked against `canmodifysession` for that student's section. Instructors also have `isDisplayedToStudents` and `displayName`.

## j. Roster enrollment

Page: `web/app/pages-instructor/instructor-course-enroll-page/`, spreadsheet grid with columns in order `Section, Team, Name, Email, Comments`. Backend: `ui/request/StudentEnrollRequest.java`, `logic/core/EnrollmentLogic.java`, `common/util/FieldValidator.java`.
- Required: Name, Email, Team, Section (the UI fills empty Section with "Default Section" and empty Team with "Default Team"; backend rejects empty values). Comments optional (max 500 chars).
- Limits: name 100, team 60, section 60, email 254. Names/team/section must not contain `|` or `%`; the UI message says they must start with an alphabetical character unless wrapped in `{}`. A team name that looks like an email is rejected.
- Duplicate emails (case-insensitive) in one submission are rejected. Existing email in the course means update (name, team, comments), otherwise create. Section and team are created on demand.
- Teams are unique per (section, name) (`Team.java` unique constraint); sections unique per course. A team name used in two sections makes two teams. I found no rule forbidding that.
- Section size limit 100 students (`Const.SECTION_SIZE_LIMIT`); exceeding it rolls back the enrollment. The UI sends batches of 50.

## k. Results

Instructor results page: `web/app/pages-instructor/instructor-session-result-page/`. View types (`InstructorSessionResultViewType`): `QUESTION`, `GRQ` (giver, recipient, question), `RGQ` (recipient, giver, question), `GQR` (giver, question, recipient), `RQG` (recipient, question, giver). Options: show statistics, indicate missing responses (rows with "No Response"), section filter with `InstructorSessionResultSectionType` `EITHER, GIVER, EVALUEE, BOTH`, a list of students with no responses, response moderation button per response.

CSV (`web/services/session-result-csv.service.ts`):
- Optional top rows: `Section Name`, `Section View Detail`, then two blank rows.
- Per question (sorted by number): row `Question N`, brief; optional `Summary Statistics` block (per-type, see below); then header row `Team, Giver's Name, Giver's Email, Recipient's Team, Recipient's Name, Recipient's Email, <type-specific columns>, Giver's Comment`, then repeated `Comment From, Comment` pairs when instructor comments are allowed (all types except CONTRIB). Responses sorted by giver team, giver, recipient team, recipient.
- Type-specific answer columns: default `Feedback`; MCQ/MSQ `Feedback` plus the choices (MSQ); CONSTSUM_OPTIONS `Feedback` plus option names; RANK_OPTIONS `Feedback, Rank 1..N`; RUBRIC `Sub Question, Choice Value, Choice Number`. Missing response cell is `No Response` (rubric: `All Sub-Questions, No Response`).
- Stats headers: CONTRIB `Team, Name, Email, CC, PC, Ratings Received` (preceded by an explanatory legend); NUMSCALE `Team, Recipient, Recipient Email, Average, Minimum, Maximum` (+ `Average excluding self response`); CONSTSUM_OPTIONS `Option, Total Points, Average Points, Points Received`; RANK_OPTIONS `Option, Overall Rank, Ranks Received`; RUBRIC `Team, Recipient Name, Recipient Email, Sub Question, <choices>, Total, Average`.
- Non-submitter CSV: `Team, Name, Email`.

Response moderation: an instructor opens the submission page as a student or instructor (request param `fsmoderatedperson`), bypassing the open/closed check; needs `canmodifysession` (for students, for that student's section) (`BasicFeedbackSubmissionAction.java`). Preview-as (`previewas`) needs `canmodifysession`.
Instructor comments: entity `ResponseInstructorComment` (response, instructor giver, `commentText`, updatedAt). Create, update, delete actions exist; creating needs `cansubmitsession`. Multiple per response. Not allowed on CONTRIB. I did not find per-comment visibility settings.

## Issues encountered

- Default visibility and feedback path for a brand-new question in the editor was not located. I read only the first part of the preset list in `getCommonFeedbackVisibilitySettings`.
- RUBRIC default choices and descriptions shown by the editor were not found; backend defaults are empty lists.
- CSV per-answer text for types other than CONTRIB was not read in detail (only headers).
- Who sees instructor comments (students or not) was not traced; `SessionResultsData` builds comments but I did not read the student path.
- The Db query for the closed email requires `isClosingSoonEmailEnabled`; I report it as coded, but it may be unintended.
- Backend does not enforce the allowed-paths table for types other than CONTRIB; the table comes from the frontend service.
- No "session visible from" setting exists in this version, contrary to what the brief assumed.
- Unclear whether a join-invite email is sent automatically on enrollment; only manual and email-change sends were found.
- Instructor permission descriptions come from `instructor-role-description.pipe.ts` plus action-level checks; I did not audit every action.
- Word budget limited coverage of student-side results display for each type.
