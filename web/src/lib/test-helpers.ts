// Shared builders for the lib tests. Not imported by app code.

import { DetailsByType, QuestionDraft, QuestionFields, QuestionType, Recipient } from './types';

const BASE: QuestionFields = {
  number: 1,
  brief: 'A question',
  description: '',
  giver_type: 'students',
  recipient_type: 'own_team_members_including_self',
  max_recipients: null,
  show_responses_to: ['instructors'],
  show_giver_name_to: ['instructors'],
  show_recipient_name_to: ['instructors'],
};

/** A question draft of the given type; `over` may override any field. */
export function q<T extends QuestionType>(type: T, details: DetailsByType[T], over: Partial<QuestionFields> = {}): QuestionDraft {
  return { ...BASE, ...over, type, details } as QuestionDraft;
}

/** Recipients with keys r1..rN. */
export function recips(n: number): Recipient[] {
  return Array.from({ length: n }, (_, i) => ({ recipient_key: `r${i + 1}`, display_name: `R${i + 1}`, team_key: 't:A|T' }));
}

/** Submission rows for recipients r1..rN with the given answers. */
export function subs(...answers: unknown[]): { recipient_key: string; answer: unknown }[] {
  return answers.map((answer, i) => ({ recipient_key: `r${i + 1}`, answer }));
}
