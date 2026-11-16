// Typed wrappers for the student RPCs and the recover-links Edge Function.
// Errors are thrown as StudentApiError with an ErrorCode (see lib/errors.ts) and human text.

import { supabase, isConfigured } from './client';
import type { AnswerToSave, StudentPortalData, StudentResultsData, StudentSessionPayload } from '../lib/studentTypes';
import { MappedError, NETWORK_MESSAGE, mapRpcError } from '../lib/studentView';

export type * from '../lib/studentTypes';

export class StudentApiError extends Error {
  readonly code: MappedError['code'];
  readonly recipient_key: string | null;
  constructor(mapped: MappedError) {
    super(mapped.message);
    this.name = 'StudentApiError';
    this.code = mapped.code;
    this.recipient_key = mapped.recipient_key;
  }
}

// ---------------------------------------------------------------------------
// Calls

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  let result;
  try {
    result = await supabase.rpc(name, args);
  } catch (e) {
    throw new StudentApiError(mapRpcError(e));
  }
  if (result.error) throw new StudentApiError(mapRpcError(result.error));
  return result.data as T;
}

export function studentPortal(token: string): Promise<StudentPortalData> {
  return rpc('student_portal', { p_token: token });
}

export function studentGetSession(token: string, sessionId: string): Promise<StudentSessionPayload> {
  return rpc('student_get_session', { p_token: token, p_session: sessionId });
}

export function studentSubmit(
  token: string,
  sessionId: string,
  questionId: string,
  answers: AnswerToSave[],
): Promise<{ saved: number }> {
  return rpc('student_submit', { p_token: token, p_session: sessionId, p_question: questionId, p_answers: answers });
}

export function studentGetResults(token: string, sessionId: string): Promise<StudentResultsData> {
  return rpc('student_get_results', { p_token: token, p_session: sessionId });
}

/**
 * Ask the recover-links Edge Function to email the student's links. The function always answers
 * ok, whether or not the address is on a roster. Only a failure to reach it throws.
 */
export async function recoverLinks(email: string): Promise<void> {
  const url = import.meta.env.VITE_SUPABASE_URL ?? '';
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
  if (!isConfigured) throw new StudentApiError({ code: 'network', message: NETWORK_MESSAGE, recipient_key: null });
  let res: Response;
  try {
    res = await fetch(`${url}/functions/v1/recover-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ email: email.trim() }),
    });
  } catch (e) {
    throw new StudentApiError(mapRpcError(e));
  }
  // 429 and friends are treated like success on purpose: the answer must not reveal anything.
  if (res.status >= 500) throw new StudentApiError({ code: 'unknown', message: 'Something went wrong. Please try again.', recipient_key: null });
}
