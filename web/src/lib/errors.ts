// Error codes shared with SQL (ARCHITECTURE.md section 6). The same strings are used in
// `raise exception '<code>'` and in validate_answers() / validate_question() results.
// Messages here are for the UI; SQL only needs the codes.

export const ERROR_MESSAGES = {
  // Access and state (raised by RPCs)
  invalid_token: 'This link is not valid. Ask your instructor for a new one.',
  not_open_yet: 'This session is not open yet.',
  deadline_passed: 'The deadline for this session has passed.',
  not_published: 'Results are not published yet.',
  not_a_giver: 'You are not a giver for this question.',
  forbidden: 'You do not have permission to do that.',
  not_found: 'Not found.',
  invalid_input: 'Some of the input is not valid.',

  // Answers
  invalid_answer: 'The answer is not in the expected format.',
  empty_text: 'Please enter an answer.',
  not_a_choice: 'The answer is not one of the choices.',
  other_not_allowed: 'This question does not allow an "Other" answer.',
  empty_other: 'Please fill in the "Other" text.',
  duplicate_choice: 'Each choice can be selected only once.',
  too_few_selected: 'You selected too few choices.',
  too_many_selected: 'You selected too many choices.',
  out_of_range: 'The value is outside the allowed range.',
  not_on_step: 'The value is not one of the allowed steps.',
  sum_mismatch: 'The points do not add up to the required total.',
  negative_points: 'Points cannot be negative.',
  below_min_point: 'A value is below the minimum allowed.',
  above_max_point: 'A value is above the maximum allowed.',
  not_enough_distinct: 'At least two options must get different numbers of points.',
  not_all_distinct: 'Every option must get a different number of points.',
  wrong_option_count: 'The answer does not match the number of options.',
  duplicate_rank: 'Each rank can be used only once.',
  rank_out_of_range: 'A rank is outside the allowed range.',
  too_few_ranked: 'You ranked too few items.',
  too_many_ranked: 'You ranked too many items.',
  invalid_contrib_value: 'The contribution value is not allowed.',
  contrib_all_required: 'Answer for every team member (or leave the whole question blank).',
  invalid_rubric_choice: 'A rubric choice is not valid.',
  no_rubric_answer: 'Answer at least one row.',
  not_a_recipient: 'That recipient is not allowed for this question.',
  duplicate_recipient: 'The same recipient appears more than once.',
  too_many_recipients: 'You answered for more recipients than allowed.',

  // Question settings
  brief_required: 'The question text is required.',
  invalid_type: 'Unknown question type.',
  invalid_giver_type: 'Unknown giver type.',
  invalid_recipient_type: 'Unknown recipient type.',
  invalid_path: 'This giver and recipient combination is not allowed for this question type.',
  invalid_max_recipients: 'The number of recipients must be a whole number of at least 1.',
  invalid_visibility: 'The visibility settings are not valid.',
  invalid_number: 'The question number must be a whole number of at least 1.',
  invalid_recommended_length: 'Recommended length must be a whole number of at least 1.',
  too_few_choices: 'Add at least two choices.',
  empty_choice: 'Choices cannot be blank.',
  duplicate_option: 'Duplicate choices are not allowed.',
  invalid_scale: 'The scale needs min less than max and a step above 0.',
  invalid_points: 'Total points must be a whole number of at least 1.',
  invalid_min_max_point: 'The minimum and maximum points are not valid.',
  invalid_distribute: 'Unknown distribution setting.',
  invalid_selectable_limits: 'The minimum and maximum selectable choices are not valid.',
  invalid_rank_limits: 'The minimum and maximum ranked items are not valid.',
  contrib_conflict: 'Zero-sum and "Not sure" cannot both be on.',
  contrib_visibility_pair: 'For this question, "recipient" and "giver team members" must be set together.',
  invalid_rubric: 'The rubric needs at least two choices, at least one non-blank sub-question and a full description grid.',

  // Roster
  required_field_missing: 'A required field is empty.',
  too_long: 'A value is too long.',
  forbidden_char: 'Names, teams and sections cannot contain "|" or "%".',
  invalid_email: 'The email address is not valid.',
  duplicate_email: 'The same email appears more than once.',
  team_looks_like_email: 'A team name cannot look like an email address.',
  section_too_large: 'A section can have at most 100 students.',
  wrong_column_count: 'The row has too many columns.',

  // Sessions
  invalid_time_range: 'The close time must be after the open time.',
  invalid_grace: 'The grace period must be 0 to 30 minutes in steps of 5.',
  invalid_extension: 'An extension must be later than the session close time.',
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export const ERROR_CODES = Object.keys(ERROR_MESSAGES) as ErrorCode[];

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, v);
}

/** Human message for a code; unknown codes (for example a raw Postgres message) get a generic text. */
export function errorMessage(code: string): string {
  return isErrorCode(code) ? ERROR_MESSAGES[code] : 'Something went wrong. Please try again.';
}

export interface ValidationError {
  code: ErrorCode;
  message: string;
  /** Present when the error belongs to one answer row. */
  recipient_key?: string;
  /** Present for question-setting errors: the details or field name. */
  field?: string;
}

export function makeError(code: ErrorCode, extra?: { recipient_key?: string; field?: string }): ValidationError {
  return { code, message: ERROR_MESSAGES[code], ...extra };
}

/**
 * Pull the code out of a Supabase/PostgREST error. RPCs raise `raise exception '<code>'`, which
 * surfaces as `error.message === '<code>'`. Returns null when the message is not a known code.
 */
export function codeFromSupabaseError(error: { message?: string } | null | undefined): ErrorCode | null {
  const m = error?.message?.trim();
  return m && isErrorCode(m) ? m : null;
}
