// Pure helpers for the student pages: error mapping, status and time text, results grouping.
// No React, no network. Added by the student UI step (BUILD_NOTES/04-student-ui.md).

import { ErrorCode, errorMessage, isErrorCode } from './errors';
import { contribValueText } from './answerText';
import { Instant, SessionStatus, timeUntil, toMs } from './time';

// ---------------------------------------------------------------------------
// Errors

/** What the UI shows for a failed call. `code` is an ErrorCode, 'network' or 'unknown'. */
export interface MappedError {
  code: ErrorCode | 'network' | 'unknown';
  message: string;
  /** For answer errors: the recipient row the server blamed (from `error.details`). */
  recipient_key: string | null;
}

export const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.';
export const UNKNOWN_MESSAGE = 'Something went wrong. Please try again.';

interface ErrorLike {
  message?: unknown;
  details?: unknown;
  code?: unknown;
  name?: unknown;
  recipient_key?: unknown;
}

/**
 * Map anything thrown or returned by supabase-js (PostgREST error object, Error, fetch failure)
 * to a code and text. RPCs raise `raise exception '<code>'`, so `message` is the code and
 * `details` may hold the recipient key.
 */
export function mapRpcError(error: unknown): MappedError {
  const e: ErrorLike = typeof error === 'object' && error !== null ? (error as ErrorLike) : {};
  const message = typeof e.message === 'string' ? e.message.trim() : typeof error === 'string' ? error.trim() : '';
  const details = typeof e.details === 'string' && e.details.trim() !== '' ? e.details.trim() : null;

  // Already mapped (a StudentApiError from api/student.ts): keep its code, text and row.
  if (typeof e.code === 'string' && (isErrorCode(e.code) || e.code === 'network' || e.code === 'unknown')) {
    const key = typeof e.recipient_key === 'string' ? e.recipient_key : null;
    const text = message !== '' ? message : e.code === 'network' ? NETWORK_MESSAGE : isErrorCode(e.code) ? errorMessage(e.code) : UNKNOWN_MESSAGE;
    return { code: e.code, message: text, recipient_key: key };
  }
  if (isErrorCode(message)) {
    const keyLike = details !== null && /^(s:|i:|t:|none$)/.test(details);
    return { code: message, message: errorMessage(message), recipient_key: keyLike ? details : null };
  }
  const networkLike =
    e.name === 'TypeError' ||
    /failed to fetch|networkerror|network request failed|load failed|fetch failed|timed? ?out/i.test(message);
  if (networkLike) return { code: 'network', message: NETWORK_MESSAGE, recipient_key: null };
  return { code: 'unknown', message: UNKNOWN_MESSAGE, recipient_key: null };
}

/** Codes the student pages treat as "this link is wrong". */
export function isInvalidToken(e: MappedError): boolean {
  return e.code === 'invalid_token';
}

// ---------------------------------------------------------------------------
// Session status and time text

/**
 * Status for display. The server status is used, except that a deadline that has passed on the
 * student's clock turns it into 'closed' (the server still has the last word on submit), and an 'open'
 * session past the printed deadline (`shownDeadline`) but before the real cutoff shows as 'grace'.
 */
export function effectiveStatus(status: SessionStatus, deadline: Instant, now: Instant, shownDeadline?: Instant | null): SessionStatus {
  if (status === 'closed') return 'closed';
  if (toMs(now) >= toMs(deadline)) return 'closed';
  if (status === 'open' && shownDeadline != null && toMs(now) >= toMs(shownDeadline)) return 'grace';
  return status;
}

/** The deadline to print on student pages: shown_deadline (close time or extension), else the real cutoff for older payloads. */
export function printedDeadline(s: { deadline: string; shown_deadline?: string }): string {
  return s.shown_deadline ?? s.deadline;
}

/**
 * "3 of 5 questions answered". Every question is optional, so this informs; it does not label the student.
 * Null when the payload has no counts (older backend).
 */
export function answeredText(answered: number | undefined, answerable: number | undefined): string | null {
  if (answered === undefined || answerable === undefined) return null;
  if (answerable === 0) return 'No questions for you';
  return `${answered} of ${answerable} ${answerable === 1 ? 'question' : 'questions'} answered`;
}

export const STATUS_LABELS: Record<SessionStatus, string> = {
  not_open: 'Not open yet',
  open: 'Open',
  grace: 'Late period',
  closed: 'Closed',
};

/** "2 days 3 h left", "45 min left", "Less than a minute left". Empty when the time has passed. */
export function timeLeftText(deadline: Instant, now: Instant): string {
  if (toMs(deadline) <= toMs(now)) return '';
  const { days, hours, minutes } = timeUntil(deadline, now);
  if (days > 0) return `${days} ${days === 1 ? 'day' : 'days'} ${hours} h left`;
  if (hours > 0) return `${hours} h ${minutes} min left`;
  if (minutes > 0) return `${minutes} min left`;
  return 'Less than a minute left';
}

// ---------------------------------------------------------------------------
// Results

export interface ResultRow {
  giver_name: string;
  recipient_name: string;
  answer: unknown;
  giver_comment: string | null;
  is_own: boolean;
  recipient_is_me: boolean;
}

export type ResultGroupId = 'about_you' | 'you_gave' | 'others';

export const RESULT_GROUP_TITLES: Record<ResultGroupId, string> = {
  about_you: 'About you',
  you_gave: 'You gave',
  others: 'Others',
};

/** Which group a row belongs to. Own answers come first, so a self-rating is under "You gave". */
export function resultGroup(row: Pick<ResultRow, 'is_own' | 'recipient_is_me'>): ResultGroupId {
  if (row.is_own) return 'you_gave';
  if (row.recipient_is_me) return 'about_you';
  return 'others';
}

/** Split rows into the three groups, keeping the server order. Empty groups are left out. */
export function groupResults<T extends Pick<ResultRow, 'is_own' | 'recipient_is_me'>>(
  rows: readonly T[],
): { id: ResultGroupId; title: string; rows: T[] }[] {
  const order: ResultGroupId[] = ['about_you', 'you_gave', 'others'];
  return order
    .map((id) => ({ id, title: RESULT_GROUP_TITLES[id], rows: rows.filter((r) => resultGroup(r) === id) }))
    .filter((g) => g.rows.length > 0);
}

export const NO_RECIPIENT_NAME_TEXT = '(no recipient)';

/** The "From X", "To Y" or "X to Y" line for a row in a group. */
export function resultRowTitle(group: ResultGroupId, row: Pick<ResultRow, 'giver_name' | 'recipient_name'>): string {
  const noRecipient = row.recipient_name === NO_RECIPIENT_NAME_TEXT;
  if (group === 'about_you') return `From ${row.giver_name}`;
  if (group === 'you_gave') return noRecipient ? 'Your answer' : `To ${row.recipient_name}`;
  return noRecipient ? row.giver_name : `${row.giver_name} to ${row.recipient_name}`;
}

/** Equal share wording for a contribution figure, with the sentinel values in words. */
export function contribFigureText(value: number): string {
  if (value === -999) return 'Not submitted';
  if (value === -9999) return 'Not available';
  const t = contribValueText(value);
  return t === '' ? String(value) : t;
}

/** The student's own claim: their rating of themself and of each teammate (descending). */
export interface ContribClaim {
  own: number;
  others: number[];
}

/** The team's view of the student only. Teammates' figures are not returned (they would let a student work out a teammate's ratings). */
export interface ContribTeamView {
  own: number;
}

/** Lines for the contribution summary, given the server's `contrib` object. */
export function contribSummaryLines(contrib: {
  my_claim: ContribClaim;
  team_view_of_me: ContribTeamView;
}): { heading: string; lines: string[] }[] {
  const list = (xs: number[]) => xs.map(contribFigureText).join(', ');
  return [
    {
      heading: 'Your claim',
      lines: [
        `You: ${contribFigureText(contrib.my_claim.own)}`,
        ...(contrib.my_claim.others.length > 0 ? [`Your teammates: ${list(contrib.my_claim.others)}`] : []),
      ],
    },
    {
      heading: "Your team's view of you",
      lines: [`You: ${contribFigureText(contrib.team_view_of_me.own)}`],
    },
  ];
}
