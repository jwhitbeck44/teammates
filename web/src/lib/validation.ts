// Question and answer validation (ARCHITECTURE.md section 6, spec section a).
// SQL validate_question() and validate_answers() are the authority; these return the same codes.

import { ErrorCode, ValidationError, makeError } from './errors';
import { isAllowedPath, recipientLimit } from './recipients';
import {
  AnswerSubmission,
  CONTRIB_NOT_SURE,
  DISTRIBUTE_MODES,
  GIVER_TYPES,
  QUESTION_TYPES,
  QuestionDraft,
  RECIPIENT_TYPES,
  RUBRIC_UNANSWERED,
  Recipient,
  VISIBILITY_TYPES,
  VisibilityType,
  isGiverType,
  isQuestionType,
  isRecipientType,
  isVisibilityType,
} from './types';

// ---------------------------------------------------------------------------
// Small helpers (inputs may be untrusted JSON, so nothing is assumed)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const blank = (s: string): boolean => s.trim() === '';

/** Tolerance for numeric scale steps (ARCHITECTURE.md section 6). */
export const STEP_TOLERANCE = 1e-9;

function hasDuplicates(items: string[]): boolean {
  const seen = new Set<string>();
  for (const s of items) {
    const k = s.trim();
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

class Errors {
  list: ValidationError[] = [];
  add(code: ErrorCode, extra?: { recipient_key?: string; field?: string }): void {
    // Do not repeat the same code for the same row and field.
    if (this.list.some((e) => e.code === code && e.recipient_key === extra?.recipient_key && e.field === extra?.field)) return;
    this.list.push(makeError(code, extra));
  }
}

// ---------------------------------------------------------------------------
// validateQuestion

function validateVisibility(q: QuestionDraft, errs: Errors): void {
  const lists: [string, unknown][] = [
    ['show_responses_to', q.show_responses_to],
    ['show_giver_name_to', q.show_giver_name_to],
    ['show_recipient_name_to', q.show_recipient_name_to],
  ];
  for (const [field, list] of lists) {
    if (!Array.isArray(list) || !list.every(isVisibilityType) || new Set(list).size !== list.length) {
      errs.add('invalid_visibility', { field });
      return;
    }
  }
  const responses = new Set<VisibilityType>(q.show_responses_to);
  // Naming someone requires letting them see the response (spec section d).
  for (const v of q.show_giver_name_to) if (!responses.has(v)) errs.add('invalid_visibility', { field: 'show_giver_name_to' });
  for (const v of q.show_recipient_name_to) if (!responses.has(v)) errs.add('invalid_visibility', { field: 'show_recipient_name_to' });
  if (q.type === 'contrib' && responses.has('recipient') !== responses.has('giver_team_members')) {
    errs.add('contrib_visibility_pair', { field: 'show_responses_to' });
  }
}

function validateChoiceList(choices: unknown, errs: Errors, field: string): choices is string[] {
  if (!isStrArray(choices)) {
    errs.add('invalid_input', { field });
    return false;
  }
  if (choices.length < 2) errs.add('too_few_choices', { field });
  if (choices.some(blank)) errs.add('empty_choice', { field });
  if (hasDuplicates(choices)) errs.add('duplicate_option', { field });
  return true;
}

function validatePointBounds(
  d: { minPoint?: unknown; maxPoint?: unknown },
  total: number | null,
  optionCount: number | null,
  errs: Errors,
): void {
  const { minPoint, maxPoint } = d;
  const minSet = minPoint !== undefined && minPoint !== null;
  const maxSet = maxPoint !== undefined && maxPoint !== null;
  if (minSet && (!isInt(minPoint) || minPoint < 0)) errs.add('invalid_min_max_point', { field: 'minPoint' });
  if (maxSet && (!isInt(maxPoint) || maxPoint < 0)) errs.add('invalid_min_max_point', { field: 'maxPoint' });
  if (minSet && maxSet && isInt(minPoint) && isInt(maxPoint) && minPoint > maxPoint) {
    errs.add('invalid_min_max_point', { field: 'maxPoint' });
  }
  if (total !== null) {
    if (minSet && isInt(minPoint) && minPoint > total) errs.add('invalid_min_max_point', { field: 'minPoint' });
    if (maxSet && isInt(maxPoint) && maxPoint > total) errs.add('invalid_min_max_point', { field: 'maxPoint' });
    if (optionCount !== null && optionCount > 0) {
      // To make a full distribution possible: min <= floor(total/n), max >= ceil(total/n).
      if (minSet && isInt(minPoint) && minPoint > Math.floor(total / optionCount)) errs.add('invalid_min_max_point', { field: 'minPoint' });
      if (maxSet && isInt(maxPoint) && maxPoint < Math.ceil(total / optionCount)) errs.add('invalid_min_max_point', { field: 'maxPoint' });
    }
  }
}

/** Validate a question's settings and details. Returns [] when valid. */
export function validateQuestion(q: QuestionDraft): ValidationError[] {
  const errs = new Errors();

  if (!isQuestionType(q.type)) {
    errs.add('invalid_type', { field: 'type' });
    return errs.list;
  }
  if (typeof q.brief !== 'string' || blank(q.brief)) errs.add('brief_required', { field: 'brief' });
  if (!isInt(q.number) || q.number < 1) errs.add('invalid_number', { field: 'number' });
  if (q.max_recipients !== null && (!isInt(q.max_recipients) || q.max_recipients < 1)) {
    errs.add('invalid_max_recipients', { field: 'max_recipients' });
  }

  const giverOk = isGiverType(q.giver_type);
  const recipOk = isRecipientType(q.recipient_type);
  if (!giverOk) errs.add('invalid_giver_type', { field: 'giver_type' });
  if (!recipOk) errs.add('invalid_recipient_type', { field: 'recipient_type' });
  if (giverOk && recipOk && !isAllowedPath(q.giver_type, q.recipient_type, q.type)) {
    errs.add('invalid_path', { field: 'recipient_type' });
  }

  validateVisibility(q, errs);

  const d: unknown = q.details;
  if (!isObj(d)) {
    errs.add('invalid_input', { field: 'details' });
    return errs.list;
  }

  switch (q.type) {
    case 'text': {
      if (d.recommendedLength !== undefined && (!isInt(d.recommendedLength) || d.recommendedLength < 1)) {
        errs.add('invalid_recommended_length', { field: 'recommendedLength' });
      }
      break;
    }
    case 'mcq': {
      validateChoiceList(d.choices, errs, 'choices');
      if (typeof d.otherEnabled !== 'boolean') errs.add('invalid_input', { field: 'otherEnabled' });
      break;
    }
    case 'msq': {
      const ok = validateChoiceList(d.choices, errs, 'choices');
      if (typeof d.otherEnabled !== 'boolean') errs.add('invalid_input', { field: 'otherEnabled' });
      const n = isStrArray(d.choices) ? d.choices.length + (d.otherEnabled === true ? 1 : 0) : 0;
      const minSet = d.minSelectable !== undefined && d.minSelectable !== null;
      const maxSet = d.maxSelectable !== undefined && d.maxSelectable !== null;
      if (maxSet && (!isInt(d.maxSelectable) || d.maxSelectable < 2 || (ok && d.maxSelectable > n))) {
        errs.add('invalid_selectable_limits', { field: 'maxSelectable' });
      }
      if (minSet && (!isInt(d.minSelectable) || d.minSelectable < 1 || (ok && d.minSelectable > n))) {
        errs.add('invalid_selectable_limits', { field: 'minSelectable' });
      }
      if (minSet && maxSet && isInt(d.minSelectable) && isInt(d.maxSelectable) && d.minSelectable > d.maxSelectable) {
        errs.add('invalid_selectable_limits', { field: 'minSelectable' });
      }
      break;
    }
    case 'numscale': {
      if (!isNum(d.min) || !isNum(d.max) || !isNum(d.step) || d.min >= d.max || d.step <= 0) {
        errs.add('invalid_scale', { field: 'details' });
      }
      break;
    }
    case 'constsum_options': {
      const options = isStrArray(d.options) ? d.options : null;
      if (options === null) errs.add('invalid_input', { field: 'options' });
      else {
        if (options.length < 2) errs.add('too_few_choices', { field: 'options' });
        if (options.some(blank)) errs.add('empty_choice', { field: 'options' });
        if (hasDuplicates(options)) errs.add('duplicate_option', { field: 'options' });
      }
      if (typeof d.pointsPerOption !== 'boolean') errs.add('invalid_input', { field: 'pointsPerOption' });
      if (!isInt(d.points) || d.points < 1) errs.add('invalid_points', { field: 'points' });
      if (!(DISTRIBUTE_MODES as readonly unknown[]).includes(d.distribute)) errs.add('invalid_distribute', { field: 'distribute' });
      if (options !== null && isInt(d.points) && d.points >= 1) {
        const total = d.pointsPerOption === true ? d.points * options.length : d.points;
        validatePointBounds(d, total, options.length, errs);
      }
      break;
    }
    case 'constsum_recipients': {
      if (typeof d.pointsPerOption !== 'boolean') errs.add('invalid_input', { field: 'pointsPerOption' });
      if (!isInt(d.points) || d.points < 1) errs.add('invalid_points', { field: 'points' });
      if (!(DISTRIBUTE_MODES as readonly unknown[]).includes(d.distribute)) errs.add('invalid_distribute', { field: 'distribute' });
      // The number of recipients is not known here, so the total is only checked when fixed.
      const total = d.pointsPerOption === false && isInt(d.points) && d.points >= 1 ? d.points : null;
      validatePointBounds(d, total, null, errs);
      break;
    }
    case 'contrib': {
      if (typeof d.isZeroSum !== 'boolean' || typeof d.isNotSureAllowed !== 'boolean') {
        errs.add('invalid_input', { field: 'details' });
      } else if (d.isZeroSum && d.isNotSureAllowed) {
        errs.add('contrib_conflict', { field: 'details' });
      }
      if (q.max_recipients !== null) errs.add('invalid_max_recipients', { field: 'max_recipients' });
      break;
    }
    case 'rubric': {
      const okC = isStrArray(d.choices);
      const okS = isStrArray(d.subQuestions);
      const okD = Array.isArray(d.descriptions) && d.descriptions.every(isStrArray);
      if (!okC || !okS || !okD) {
        errs.add('invalid_rubric', { field: 'details' });
      } else {
        const choices = d.choices as string[];
        const subs = d.subQuestions as string[];
        const desc = d.descriptions as string[][];
        // Blank choices are allowed (spec section a); blank sub-questions are not.
        const gridOk = desc.length === subs.length && desc.every((row) => row.length === choices.length);
        if (choices.length < 2 || subs.length < 1 || subs.some(blank) || !gridOk) {
          errs.add('invalid_rubric', { field: 'details' });
        }
      }
      break;
    }
    case 'rank_options':
    case 'rank_recipients': {
      let n: number | null = null;
      if (q.type === 'rank_options') {
        const options = isStrArray(d.options) ? d.options : null;
        if (options === null) errs.add('invalid_input', { field: 'options' });
        else {
          n = options.length;
          if (n < 2) errs.add('too_few_choices', { field: 'options' });
          if (options.some(blank)) errs.add('empty_choice', { field: 'options' });
          if (hasDuplicates(options)) errs.add('duplicate_option', { field: 'options' });
        }
      }
      if (typeof d.duplicatesAllowed !== 'boolean') errs.add('invalid_input', { field: 'duplicatesAllowed' });
      const minSet = d.minToRank !== undefined && d.minToRank !== null;
      const maxSet = d.maxToRank !== undefined && d.maxToRank !== null;
      if (minSet && (!isInt(d.minToRank) || d.minToRank < 1 || (n !== null && d.minToRank > n))) {
        errs.add('invalid_rank_limits', { field: 'minToRank' });
      }
      if (maxSet && (!isInt(d.maxToRank) || d.maxToRank < 1 || (n !== null && d.maxToRank > n))) {
        errs.add('invalid_rank_limits', { field: 'maxToRank' });
      }
      if (minSet && maxSet && isInt(d.minToRank) && isInt(d.maxToRank) && d.minToRank > d.maxToRank) {
        errs.add('invalid_rank_limits', { field: 'minToRank' });
      }
      break;
    }
  }
  return errs.list;
}

// ---------------------------------------------------------------------------
// validateAnswers

type Sub = AnswerSubmission;

function checkDistribution(
  values: number[],
  total: number,
  d: { minPoint?: number; maxPoint?: number; distribute: string },
  errs: Errors,
  key?: string,
): void {
  const ex = key === undefined ? undefined : { recipient_key: key };
  if (values.some((v) => v < 0)) {
    errs.add('negative_points', ex);
    return;
  }
  if (d.minPoint != null && values.some((v) => v < d.minPoint!)) errs.add('below_min_point', ex);
  if (d.maxPoint != null && values.some((v) => v > d.maxPoint!)) errs.add('above_max_point', ex);
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum !== total) {
    errs.add('sum_mismatch', ex);
    return;
  }
  const distinct = new Set(values).size;
  if (d.distribute === 'some' && distinct < 2) errs.add('not_enough_distinct', ex);
  if (d.distribute === 'all' && distinct !== values.length) errs.add('not_all_distinct', ex);
}

function checkRankCount(count: number, min: number | undefined, max: number | undefined, errs: Errors, key?: string): void {
  const ex = key === undefined ? undefined : { recipient_key: key };
  if (min != null && count < min) errs.add('too_few_ranked', ex);
  if (max != null && count > max) errs.add('too_many_ranked', ex);
}

/**
 * Validate one giver's answers for one question.
 *
 * @param recipients the giver's resolved recipients (resolveRecipients result)
 * @param answers the rows to save; an empty array is valid and means "delete my answers"
 * @returns [] when valid
 */
export function validateAnswers(
  question: QuestionDraft,
  recipients: readonly Recipient[],
  answers: readonly Sub[],
): ValidationError[] {
  const errs = new Errors();
  if (!Array.isArray(answers)) return [makeError('invalid_input')];
  if (answers.length === 0) return [];

  // Recipient checks
  const allowed = new Set(recipients.map((r) => r.recipient_key));
  const seen = new Set<string>();
  for (const a of answers) {
    if (!isObj(a) || typeof a.recipient_key !== 'string') {
      errs.add('invalid_input');
      continue;
    }
    if (!allowed.has(a.recipient_key)) errs.add('not_a_recipient', { recipient_key: a.recipient_key });
    if (seen.has(a.recipient_key)) errs.add('duplicate_recipient', { recipient_key: a.recipient_key });
    seen.add(a.recipient_key);
    if (a.giver_comment !== undefined && a.giver_comment !== null && typeof a.giver_comment !== 'string') {
      errs.add('invalid_input', { recipient_key: a.recipient_key, field: 'giver_comment' });
    }
  }
  if (isCapped(question) && answers.length > (question.max_recipients as number)) errs.add('too_many_recipients');
  if (errs.list.length > 0) return errs.list;

  const limit = recipientLimit(recipients.length, question.max_recipients);

  switch (question.type) {
    case 'text':
      for (const a of answers) {
        const v = a.answer;
        if (!isObj(v) || typeof v.text !== 'string') errs.add('invalid_answer', { recipient_key: a.recipient_key });
        else if (blank(v.text)) errs.add('empty_text', { recipient_key: a.recipient_key });
      }
      break;

    case 'mcq': {
      const d = question.details;
      for (const a of answers) {
        const ex = { recipient_key: a.recipient_key };
        const v = a.answer;
        if (!isObj(v)) {
          errs.add('invalid_answer', ex);
          continue;
        }
        const hasChoice = v.choice !== undefined;
        const hasOther = v.other !== undefined;
        if (hasChoice === hasOther || (hasChoice && typeof v.choice !== 'string') || (hasOther && typeof v.other !== 'string')) {
          errs.add('invalid_answer', ex);
        } else if (hasChoice) {
          if (!d.choices.includes(v.choice as string)) errs.add('not_a_choice', ex);
        } else if (!d.otherEnabled) {
          errs.add('other_not_allowed', ex);
        } else if (blank(v.other as string)) {
          errs.add('empty_other', ex);
        }
      }
      break;
    }

    case 'msq': {
      const d = question.details;
      for (const a of answers) {
        const ex = { recipient_key: a.recipient_key };
        const v = a.answer;
        if (!isObj(v) || !isStrArray(v.choices) || (v.other !== undefined && typeof v.other !== 'string')) {
          errs.add('invalid_answer', ex);
          continue;
        }
        const picked = v.choices;
        if (picked.some((c) => !d.choices.includes(c))) errs.add('not_a_choice', ex);
        if (new Set(picked).size !== picked.length) errs.add('duplicate_choice', ex);
        const hasOther = v.other !== undefined;
        if (hasOther && !d.otherEnabled) errs.add('other_not_allowed', ex);
        else if (hasOther && blank(v.other as string)) errs.add('empty_other', ex);
        const count = picked.length + (hasOther ? 1 : 0);
        // "None of the above" (nothing picked) is always allowed; limits apply to real selections.
        if (count > 0) {
          if (d.minSelectable != null && count < d.minSelectable) errs.add('too_few_selected', ex);
          if (d.maxSelectable != null && count > d.maxSelectable) errs.add('too_many_selected', ex);
        }
      }
      break;
    }

    case 'numscale': {
      const d = question.details;
      for (const a of answers) {
        const ex = { recipient_key: a.recipient_key };
        const v = a.answer;
        if (!isObj(v) || !isNum(v.value)) {
          errs.add('invalid_answer', ex);
        } else if (v.value < d.min || v.value > d.max) {
          errs.add('out_of_range', ex);
        } else {
          const k = Math.round((v.value - d.min) / d.step);
          if (Math.abs(v.value - (d.min + k * d.step)) > STEP_TOLERANCE) errs.add('not_on_step', ex);
        }
      }
      break;
    }

    case 'constsum_options': {
      const d = question.details;
      const total = d.pointsPerOption ? d.points * d.options.length : d.points;
      for (const a of answers) {
        const ex = { recipient_key: a.recipient_key };
        const v = a.answer;
        if (!isObj(v) || !Array.isArray(v.points) || !v.points.every(isInt)) {
          errs.add('invalid_answer', ex);
        } else if (v.points.length !== d.options.length) {
          errs.add('wrong_option_count', ex);
        } else {
          checkDistribution(v.points as number[], total, d, errs, a.recipient_key);
        }
      }
      break;
    }

    case 'constsum_recipients': {
      const d = question.details;
      const values: number[] = [];
      let shapeOk = true;
      for (const a of answers) {
        const v = a.answer;
        if (!isObj(v) || !isInt(v.points)) {
          errs.add('invalid_answer', { recipient_key: a.recipient_key });
          shapeOk = false;
        } else values.push(v.points);
      }
      if (shapeOk) {
        // Pool is shared across all rows: total = points x answered rows when pointsPerOption.
        const total = d.pointsPerOption ? d.points * values.length : d.points;
        checkDistribution(values, total, d, errs);
      }
      break;
    }

    case 'contrib': {
      const d = question.details;
      let sum = 0;
      let shapeOk = true;
      for (const a of answers) {
        const ex = { recipient_key: a.recipient_key };
        const v = a.answer;
        if (!isObj(v) || !isInt(v.value)) {
          errs.add('invalid_answer', ex);
          shapeOk = false;
          continue;
        }
        const x = v.value;
        if (x === CONTRIB_NOT_SURE) {
          if (!d.isNotSureAllowed) errs.add('invalid_contrib_value', ex);
        } else if (x < 0 || x > 200) errs.add('out_of_range', ex);
        else if (x % 5 !== 0) errs.add('not_on_step', ex);
        else sum += x;
      }
      if (shapeOk && d.isZeroSum) {
        if (answers.length !== recipients.length) errs.add('contrib_all_required');
        else if (sum !== 100 * recipients.length) errs.add('sum_mismatch');
      }
      break;
    }

    case 'rubric': {
      const d = question.details;
      for (const a of answers) {
        const ex = { recipient_key: a.recipient_key };
        const v = a.answer;
        if (!isObj(v) || !Array.isArray(v.choices) || v.choices.length !== d.subQuestions.length) {
          errs.add('invalid_answer', ex);
          continue;
        }
        const picks = v.choices as unknown[];
        if (!picks.every((c) => isInt(c) && (c === RUBRIC_UNANSWERED || (c >= 0 && c < d.choices.length)))) {
          errs.add('invalid_rubric_choice', ex);
        } else if (picks.every((c) => c === RUBRIC_UNANSWERED)) {
          errs.add('no_rubric_answer', ex);
        }
      }
      break;
    }

    case 'rank_options': {
      const d = question.details;
      const n = d.options.length;
      for (const a of answers) {
        const ex = { recipient_key: a.recipient_key };
        const v = a.answer;
        if (!isObj(v) || !Array.isArray(v.ranks) || v.ranks.length !== n || !v.ranks.every((r) => r === null || isInt(r))) {
          errs.add('invalid_answer', ex);
          continue;
        }
        const ranked = (v.ranks as (number | null)[]).filter((r): r is number => r !== null);
        if (ranked.some((r) => r < 1 || r > n)) errs.add('rank_out_of_range', ex);
        if (!d.duplicatesAllowed && new Set(ranked).size !== ranked.length) errs.add('duplicate_rank', ex);
        if (ranked.length === 0) errs.add('too_few_ranked', ex);
        else checkRankCount(ranked.length, d.minToRank, d.maxToRank, errs, a.recipient_key);
      }
      break;
    }

    case 'rank_recipients': {
      const d = question.details;
      const ranks: number[] = [];
      let shapeOk = true;
      for (const a of answers) {
        const v = a.answer;
        if (!isObj(v) || !isInt(v.rank)) {
          errs.add('invalid_answer', { recipient_key: a.recipient_key });
          shapeOk = false;
        } else {
          ranks.push(v.rank);
          if (v.rank < 1 || v.rank > limit) errs.add('rank_out_of_range', { recipient_key: a.recipient_key });
        }
      }
      if (shapeOk) {
        if (!d.duplicatesAllowed && new Set(ranks).size !== ranks.length) errs.add('duplicate_rank');
        checkRankCount(ranks.length, d.minToRank, d.maxToRank, errs);
      }
      break;
    }

    default:
      errs.add('invalid_type');
  }
  // Size limits (SQL checks them after the shape checks, so they only show when nothing else is wrong)
  if (errs.list.length === 0) {
    for (const a of answers) {
      const v = a.answer as Record<string, unknown> | null | undefined;
      const tooLongText = (x: unknown) => typeof x === 'string' && x.length > LIMITS.answerText;
      if (isObj(v) && (tooLongText(v.text) || tooLongText(v.other))) errs.add('too_long', { recipient_key: a.recipient_key });
      else if (typeof a.giver_comment === 'string' && a.giver_comment.length > LIMITS.giverComment) {
        errs.add('too_long', { recipient_key: a.recipient_key, field: 'giver_comment' });
      }
    }
  }
  return errs.list;
}

function isCapped(q: QuestionDraft): boolean {
  return q.max_recipients !== null && q.max_recipients !== undefined;
}

/** True when validateAnswers would accept the answers. */
export function answersAreValid(question: QuestionDraft, recipients: readonly Recipient[], answers: readonly Sub[]): boolean {
  return validateAnswers(question, recipients, answers).length === 0;
}

// ---------------------------------------------------------------------------
// Roster field validation (spec section j). Used by csv.ts and the student editor.

export const LIMITS = {
  name: 100,
  team: 60,
  section: 60,
  email: 254,
  comments: 500,
  sectionSize: 100,
  sessionName: 64,
  /** Longest text (or "other") answer, in characters; same limit in SQL. */
  answerText: 10000,
  giverComment: 2000,
} as const;

export const DEFAULT_SECTION = 'Default Section';
export const DEFAULT_TEAM = 'Default Team';

export interface StudentInput {
  section: string;
  team: string;
  name: string;
  email: string;
  comments: string;
}

export interface RowError {
  /** 1-based row number in the source (header row excluded), or index + 1 for non-CSV callers */
  row: number;
  code: ErrorCode;
  field?: string;
  message: string;
}

const EMAIL_RE = /^[^\s@,;"<>()[\]\\]+@[^\s@,;"<>()[\]\\]+\.[^\s@,;"<>()[\]\\]+$/;

export function looksLikeEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

/** Normalise an email the way the database stores it: trimmed and lowercased. */
export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Validate one student row (already trimmed, defaults filled). Returns error codes with the
 * offending field. Does not check duplicates across rows or section size.
 */
export function validateStudentFields(s: StudentInput): { code: ErrorCode; field: string }[] {
  const out: { code: ErrorCode; field: string }[] = [];
  const req = (field: 'name' | 'email' | 'team' | 'section') => {
    if (s[field].trim() === '') out.push({ code: 'required_field_missing', field });
  };
  req('name');
  req('email');
  req('team');
  req('section');
  for (const f of ['name', 'team', 'section'] as const) {
    if (s[f].length > LIMITS[f]) out.push({ code: 'too_long', field: f });
    if (/[|%]/.test(s[f])) out.push({ code: 'forbidden_char', field: f });
  }
  if (s.email.length > LIMITS.email) out.push({ code: 'too_long', field: 'email' });
  else if (s.email.trim() !== '' && !looksLikeEmail(s.email)) out.push({ code: 'invalid_email', field: 'email' });
  if (s.comments.length > LIMITS.comments) out.push({ code: 'too_long', field: 'comments' });
  if (looksLikeEmail(s.team)) out.push({ code: 'team_looks_like_email', field: 'team' });
  return out;
}

// ---------------------------------------------------------------------------
// Session settings

export const GRACE_OPTIONS = [0, 5, 10, 15, 20, 25, 30] as const;

export function validateSessionSettings(s: {
  name: string;
  opens_at: string;
  closes_at: string;
  grace_minutes: number;
  results_visibility: string;
  results_visible_at: string | null;
}): ValidationError[] {
  const errs = new Errors();
  if (s.name.trim() === '') errs.add('required_field_missing', { field: 'name' });
  if (s.name.length > LIMITS.sessionName) errs.add('too_long', { field: 'name' });
  if (/[|%]/.test(s.name)) errs.add('forbidden_char', { field: 'name' });
  const o = Date.parse(s.opens_at);
  const c = Date.parse(s.closes_at);
  if (!Number.isFinite(o) || !Number.isFinite(c) || c <= o) errs.add('invalid_time_range', { field: 'closes_at' });
  if (!(GRACE_OPTIONS as readonly number[]).includes(s.grace_minutes)) errs.add('invalid_grace', { field: 'grace_minutes' });
  if (s.results_visibility === 'custom' && (s.results_visible_at === null || !Number.isFinite(Date.parse(s.results_visible_at)))) {
    errs.add('invalid_time_range', { field: 'results_visible_at' });
  } else if (!['at_open', 'custom', 'later'].includes(s.results_visibility)) {
    errs.add('invalid_input', { field: 'results_visibility' });
  }
  return errs.list;
}

// Re-exported lists for the editor
export { QUESTION_TYPES, GIVER_TYPES, RECIPIENT_TYPES, VISIBILITY_TYPES };
