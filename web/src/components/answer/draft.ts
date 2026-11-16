// Question-level draft state: which recipients are answered, one input per recipient, and the
// list of rows to send. Pure; the form component only holds this state and renders it.

import type { PayloadQuestion } from '../../lib/studentTypes';
import type { AnswerSubmission, QuestionDraft, Recipient } from '../../lib/types';
import { AnswerInput, emptyInput, inputFromAnswer, inputToAnswer } from './mapping';

export interface QuestionState {
  /** One input per recipient key. */
  inputs: Record<string, AnswerInput>;
  /** Saved giver comments, passed through unchanged (there is no input for them). */
  comments: Record<string, string | null>;
  /** Recipient keys the giver answers for. Only used when the question is capped. */
  chosen: string[];
}

/** True when the giver must pick which recipients to answer for. */
export function isCapped(q: Pick<PayloadQuestion, 'max_recipients' | 'recipients'>): boolean {
  return q.max_recipients !== null && q.max_recipients !== undefined && q.max_recipients < q.recipients.length;
}

export function initState(q: PayloadQuestion): QuestionState {
  const inputs: Record<string, AnswerInput> = {};
  const comments: Record<string, string | null> = {};
  const saved = new Map(q.answers.map((a) => [a.recipient_key, a]));
  for (const r of q.recipients) {
    const a = saved.get(r.recipient_key);
    inputs[r.recipient_key] = a ? inputFromAnswer(q.type, q.details as never, a.answer) : emptyInput(q.type, q.details as never);
    comments[r.recipient_key] = a?.giver_comment ?? null;
  }
  const chosen = q.recipients.filter((r) => saved.has(r.recipient_key)).map((r) => r.recipient_key);
  return { inputs, comments, chosen };
}

/** Recipients the giver is answering for now, in roster order. */
export function activeRecipients(q: PayloadQuestion, state: QuestionState): Recipient[] {
  if (!isCapped(q)) return q.recipients;
  return q.recipients.filter((r) => state.chosen.includes(r.recipient_key));
}

/** The rows to send: one per active recipient with a non-blank answer. */
export function buildSubmission(q: PayloadQuestion, state: QuestionState): AnswerSubmission[] {
  const out: AnswerSubmission[] = [];
  for (const r of activeRecipients(q, state)) {
    const input = state.inputs[r.recipient_key];
    if (!input) continue;
    const answer = inputToAnswer(q.type, q.details as never, input);
    if (answer === null) continue;
    const row: AnswerSubmission = { recipient_key: r.recipient_key, answer };
    const comment = state.comments[r.recipient_key];
    if (comment) row.giver_comment = comment;
    out.push(row);
  }
  return out;
}

/** Stable text form of what would be sent; used to tell saved from unsaved. */
export function signature(q: PayloadQuestion, state: QuestionState): string {
  return JSON.stringify(buildSubmission(q, state));
}

/** The question in the shape lib/validation expects (visibility lists are not needed for answers). */
export function asValidationQuestion(q: PayloadQuestion): QuestionDraft {
  return {
    ...q,
    show_responses_to: q.show_responses_to ?? [],
    show_giver_name_to: q.show_giver_name_to ?? [],
    show_recipient_name_to: q.show_recipient_name_to ?? [],
  } as QuestionDraft;
}

/** Choose or drop a recipient, never going over the cap. Returns the new list in roster order. */
export function toggleChosen(q: PayloadQuestion, chosen: readonly string[], key: string, on: boolean): string[] {
  const set = new Set(chosen);
  if (on) {
    if (q.max_recipients != null && set.size >= q.max_recipients) return [...chosen];
    set.add(key);
  } else {
    set.delete(key);
  }
  return q.recipients.map((r) => r.recipient_key).filter((k) => set.has(k));
}

export function hasAnyAnswer(q: PayloadQuestion, state: QuestionState): boolean {
  return buildSubmission(q, state).length > 0;
}

/** True when the recipient row is the signed-in student (names can repeat, so team is checked too). */
export function isSelfRecipient(
  student: { name: string; team: string; section: string } | undefined,
  q: Pick<PayloadQuestion, 'recipient_type'>,
  r: Recipient,
): boolean {
  if (q.recipient_type === 'self') return true;
  if (!student || !r.recipient_key.startsWith('s:')) return false;
  return r.display_name === student.name && r.team_key === `t:${student.section}|${student.team}`;
}

/** Highest rank offered for rank_recipients: the number of recipients, capped by max_recipients. */
export function rankLimit(q: Pick<PayloadQuestion, 'max_recipients' | 'recipients'>): number {
  const n = q.recipients.length;
  return q.max_recipients == null ? n : Math.min(q.max_recipients, n);
}
