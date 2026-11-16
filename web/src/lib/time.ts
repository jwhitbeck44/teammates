// Time zone formatting, session status, publish check and student deadline
// (ARCHITECTURE.md section 5; spec section f). Uses only Intl and Date, so it runs in browsers and Node.
// All instants are UTC; a course time zone is an IANA name such as 'America/Denver'.

import { ErrorCode } from './errors';
import { ResultsVisibility } from './types';

/** An instant: ISO 8601 string (as PostgREST returns it), Date, or epoch milliseconds. */
export type Instant = string | Date | number;

export function toMs(i: Instant): number {
  if (typeof i === 'number') return i;
  if (i instanceof Date) return i.getTime();
  return Date.parse(i);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Formatting

export interface FormatOptions {
  /** Include the weekday ("Sat, "). Default true. */
  weekday?: boolean;
  /** Include the zone abbreviation ("MST"). Default true. */
  zoneName?: boolean;
}

/**
 * "Sat, Nov 14, 2026, 11:59 PM MST". Returns '' for an invalid instant.
 * The abbreviation comes from the runtime (for example "MST", or "GMT+1" where there is no short name).
 */
export function formatInstant(instant: Instant, timeZone: string, opts: FormatOptions = {}): string {
  const ms = toMs(instant);
  if (!Number.isFinite(ms)) return '';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: opts.weekday === false ? undefined : 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: opts.zoneName === false ? undefined : 'short',
  });
  return fmt.format(new Date(ms));
}

export interface LocalParts {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number; // 0..23
  minute: number;
  second: number;
}

function partsAt(ms: number, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

/** Wall-clock parts of an instant in a time zone. */
export function instantToLocalParts(instant: Instant, timeZone: string): LocalParts {
  return partsAt(toMs(instant), timeZone);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `{date: 'YYYY-MM-DD', time: 'HH:mm'}` in the zone, for <input type="date"> and <input type="time">. */
export function instantToLocalInputs(instant: Instant, timeZone: string): { date: string; time: string } {
  const p = partsAt(toMs(instant), timeZone);
  return { date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** Offset of the zone from UTC at an instant, in milliseconds (positive east of Greenwich). */
function offsetMs(ms: number, timeZone: string): number {
  const p = partsAt(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` shows the given date and time.
 * `date` is 'YYYY-MM-DD', `time` is 'HH:mm'. Returns null for malformed input.
 * In the hour skipped by a spring-forward change the result is the instant just after the gap;
 * in the repeated hour of a fall-back change the earlier instant is returned.
 */
export function localToInstant(date: string, time: string, timeZone: string): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!dm || !tm) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [h, mi] = [Number(tm[1]), Number(tm[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(wall).getUTCDate() !== d) return null; // 31 February and so on
  // Try both offsets around the wall time; keep the earliest instant that renders back to the wall time.
  const o1 = offsetMs(wall - 12 * 3600_000, timeZone);
  const o2 = offsetMs(wall + 12 * 3600_000, timeZone);
  const candidates = [...new Set([wall - o1, wall - o2])].sort((a, b) => a - b);
  for (const c of candidates) {
    if (offsetMs(c, timeZone) === wall - c) return new Date(c);
  }
  // In a gap: no instant shows this wall time. Use the offset from before the gap, which lands just after it.
  return new Date(wall - o1);
}

// ---------------------------------------------------------------------------
// Sessions

export interface SessionTimes {
  opens_at: Instant;
  closes_at: Instant;
  grace_minutes: number;
}

export interface SessionPublishFields {
  opens_at: Instant;
  results_visibility: ResultsVisibility;
  results_visible_at: Instant | null;
  published_at: Instant | null;
}

export type SessionStatus = 'not_open' | 'open' | 'grace' | 'closed';

/** The end of the grace period: closes_at + grace_minutes. */
export function graceEnd(s: SessionTimes): number {
  return toMs(s.closes_at) + s.grace_minutes * 60_000;
}

/**
 * The deadline for one student: the extension's `closes_at` if there is one, else
 * `closes_at + grace_minutes` (ARCHITECTURE.md section 5). Returns epoch milliseconds.
 */
export function studentDeadline(s: SessionTimes, extension?: Instant | null): number {
  return extension == null ? graceEnd(s) : toMs(extension);
}

/** Session-wide status: not_open before opens_at, open until closes_at, grace until closes_at + grace, then closed. */
export function sessionStatus(s: SessionTimes, now: Instant): SessionStatus {
  const t = toMs(now);
  if (t < toMs(s.opens_at)) return 'not_open';
  if (t < toMs(s.closes_at)) return 'open';
  if (t < graceEnd(s)) return 'grace';
  return 'closed';
}

/**
 * Status for one student. Without an extension it equals sessionStatus. With an extension the
 * student is 'open' until the extension's closes_at and then 'closed' (no grace on top,
 * ARCHITECTURE.md section 5 gives the extension as the whole deadline).
 */
export function studentStatus(s: SessionTimes, now: Instant, extension?: Instant | null): SessionStatus {
  if (extension == null) return sessionStatus(s, now);
  const t = toMs(now);
  if (t < toMs(s.opens_at)) return 'not_open';
  return t < toMs(extension) ? 'open' : 'closed';
}

/** A student may submit when opens_at <= now < student deadline. */
export function canStudentSubmit(s: SessionTimes, now: Instant, extension?: Instant | null): boolean {
  const t = toMs(now);
  return t >= toMs(s.opens_at) && t < studentDeadline(s, extension);
}

/**
 * Mirror of SQL session_is_published(): published_at is set, or results are visible at open and
 * the session has opened, or results are visible at a set time that has passed.
 */
export function isPublished(s: SessionPublishFields, now: Instant): boolean {
  const t = toMs(now);
  if (s.published_at != null) return true;
  if (s.results_visibility === 'at_open') return t >= toMs(s.opens_at);
  if (s.results_visibility === 'custom') return s.results_visible_at != null && t >= toMs(s.results_visible_at);
  return false;
}

/** An extension must be later than the session close time (ARCHITECTURE.md section 5). */
export function validateExtension(s: Pick<SessionTimes, 'closes_at'>, extension: Instant): ErrorCode | null {
  const e = toMs(extension);
  return Number.isFinite(e) && e > toMs(s.closes_at) ? null : 'invalid_extension';
}

/** Whole hours and minutes until an instant, for "closes in 3 h 20 min" style text. Negative gives zeros. */
export function timeUntil(target: Instant, now: Instant): { days: number; hours: number; minutes: number } {
  const diff = Math.max(0, toMs(target) - toMs(now));
  const totalMin = Math.floor(diff / 60_000);
  return { days: Math.floor(totalMin / 1440), hours: Math.floor((totalMin % 1440) / 60), minutes: totalMin % 60 };
}
