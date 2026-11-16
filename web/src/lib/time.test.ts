import { describe, expect, it } from 'vitest';
import {
  canStudentSubmit,
  formatInstant,
  graceEnd,
  instantToLocalInputs,
  instantToLocalParts,
  isPublished,
  isValidTimeZone,
  localToInstant,
  sessionStatus,
  studentDeadline,
  studentStatus,
  timeUntil,
  validateExtension,
} from './time';

const DEN = 'America/Denver';

describe('formatting in a course time zone', () => {
  it('formats a UTC instant in Denver standard and daylight time', () => {
    expect(formatInstant('2026-11-15T06:59:00Z', DEN)).toBe('Sat, Nov 14, 2026, 11:59 PM MST');
    expect(formatInstant('2026-07-04T18:00:00Z', DEN)).toBe('Sat, Jul 4, 2026, 12:00 PM MDT');
  });
  it('the same instant reads differently in another zone, and a date can roll over', () => {
    expect(formatInstant('2026-11-15T06:59:00Z', 'UTC', { zoneName: false })).toBe('Sun, Nov 15, 2026, 6:59 AM');
    expect(formatInstant('2026-11-15T06:59:00Z', 'Pacific/Auckland', { zoneName: false, weekday: false })).toBe('Nov 15, 2026, 7:59 PM');
  });
  it('accepts Date and epoch milliseconds, and gives "" for garbage', () => {
    const iso = '2026-11-15T06:59:00Z';
    expect(formatInstant(new Date(iso), DEN)).toBe(formatInstant(Date.parse(iso), DEN));
    expect(formatInstant('not a date', DEN)).toBe('');
  });
  it('validates zone names', () => {
    expect(isValidTimeZone('America/Denver')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('local wall clock conversions', () => {
  it('splits an instant into date and time inputs', () => {
    expect(instantToLocalInputs('2026-11-15T06:59:00Z', DEN)).toEqual({ date: '2026-11-14', time: '23:59' });
    expect(instantToLocalParts('2026-03-08T09:00:00Z', DEN)).toMatchObject({ month: 3, day: 8, hour: 3, minute: 0 });
  });
  it('turns a Denver wall time into the right UTC instant (default close time 23:59)', () => {
    expect(localToInstant('2026-11-14', '23:59', DEN)?.toISOString()).toBe('2026-11-15T06:59:00.000Z');
    expect(localToInstant('2026-07-04', '23:59', DEN)?.toISOString()).toBe('2026-07-05T05:59:00.000Z');
  });
  it('round-trips through instantToLocalInputs', () => {
    for (const [d, t] of [['2026-01-15', '08:30'], ['2026-06-30', '00:00'], ['2026-12-31', '23:59']]) {
      const i = localToInstant(d, t, DEN)!;
      expect(instantToLocalInputs(i, DEN)).toEqual({ date: d, time: t });
    }
  });
  it('handles zones east of Greenwich', () => {
    expect(localToInstant('2026-11-15', '09:00', 'Asia/Kolkata')?.toISOString()).toBe('2026-11-15T03:30:00.000Z');
  });
  it('picks the earlier instant in a repeated hour and the time after a skipped hour', () => {
    expect(localToInstant('2026-11-01', '01:30', DEN)?.toISOString()).toBe('2026-11-01T07:30:00.000Z');
    expect(localToInstant('2026-03-08', '02:30', DEN)?.toISOString()).toBe('2026-03-08T09:30:00.000Z');
  });
  it('rejects malformed or impossible input', () => {
    expect(localToInstant('2026-02-31', '10:00', DEN)).toBeNull();
    expect(localToInstant('2026-13-01', '10:00', DEN)).toBeNull();
    expect(localToInstant('2026-01-01', '25:00', DEN)).toBeNull();
    expect(localToInstant('nope', '10:00', DEN)).toBeNull();
  });
});

describe('session status and deadlines (ARCHITECTURE.md section 5)', () => {
  const s = { opens_at: '2026-10-01T12:00:00Z', closes_at: '2026-10-08T12:00:00Z', grace_minutes: 15 };

  it('status moves not_open, open, grace, closed at the exact boundaries', () => {
    expect(sessionStatus(s, '2026-10-01T11:59:59Z')).toBe('not_open');
    expect(sessionStatus(s, '2026-10-01T12:00:00Z')).toBe('open');
    expect(sessionStatus(s, '2026-10-08T11:59:59Z')).toBe('open');
    expect(sessionStatus(s, '2026-10-08T12:00:00Z')).toBe('grace');
    expect(sessionStatus(s, '2026-10-08T12:14:59Z')).toBe('grace');
    expect(sessionStatus(s, '2026-10-08T12:15:00Z')).toBe('closed');
  });
  it('zero grace goes straight from open to closed', () => {
    const z = { ...s, grace_minutes: 0 };
    expect(sessionStatus(z, '2026-10-08T12:00:00Z')).toBe('closed');
  });
  it('the deadline is close time plus grace, or the extension when there is one', () => {
    expect(graceEnd(s)).toBe(Date.parse('2026-10-08T12:15:00Z'));
    expect(studentDeadline(s)).toBe(Date.parse('2026-10-08T12:15:00Z'));
    expect(studentDeadline(s, null)).toBe(Date.parse('2026-10-08T12:15:00Z'));
    expect(studentDeadline(s, '2026-10-10T12:00:00Z')).toBe(Date.parse('2026-10-10T12:00:00Z'));
  });
  it('a student may submit when opens_at <= now < deadline', () => {
    expect(canStudentSubmit(s, '2026-10-01T11:59:59Z')).toBe(false);
    expect(canStudentSubmit(s, '2026-10-01T12:00:00Z')).toBe(true);
    expect(canStudentSubmit(s, '2026-10-08T12:14:59Z')).toBe(true); // in grace
    expect(canStudentSubmit(s, '2026-10-08T12:15:00Z')).toBe(false);
  });
  it('an extension replaces the deadline, for that student only', () => {
    const ext = '2026-10-10T12:00:00Z';
    expect(canStudentSubmit(s, '2026-10-09T00:00:00Z', ext)).toBe(true);
    expect(canStudentSubmit(s, '2026-10-09T00:00:00Z')).toBe(false);
    expect(canStudentSubmit(s, '2026-10-10T12:00:00Z', ext)).toBe(false);
    expect(canStudentSubmit(s, '2026-09-30T00:00:00Z', ext)).toBe(false);
  });
  it('student status with an extension is open until the extension, then closed', () => {
    const ext = '2026-10-10T12:00:00Z';
    expect(studentStatus(s, '2026-10-09T00:00:00Z', ext)).toBe('open');
    expect(studentStatus(s, '2026-10-10T12:00:00Z', ext)).toBe('closed');
    expect(studentStatus(s, '2026-09-30T00:00:00Z', ext)).toBe('not_open');
    expect(studentStatus(s, '2026-10-08T12:05:00Z')).toBe('grace');
  });
  it('extensions must be later than the close time', () => {
    expect(validateExtension(s, '2026-10-09T00:00:00Z')).toBeNull();
    expect(validateExtension(s, '2026-10-08T12:00:00Z')).toBe('invalid_extension');
    expect(validateExtension(s, '2026-10-01T00:00:00Z')).toBe('invalid_extension');
    expect(validateExtension(s, 'garbage')).toBe('invalid_extension');
  });
  it('timeUntil gives whole days, hours and minutes and never goes negative', () => {
    expect(timeUntil('2026-10-02T13:30:30Z', '2026-10-01T12:00:00Z')).toEqual({ days: 1, hours: 1, minutes: 30 });
    expect(timeUntil('2026-10-01T00:00:00Z', '2026-10-01T12:00:00Z')).toEqual({ days: 0, hours: 0, minutes: 0 });
  });
});

describe('isPublished', () => {
  const base = { opens_at: '2026-10-01T12:00:00Z', results_visibility: 'later' as const, results_visible_at: null, published_at: null };
  it('later: only a manual publish counts', () => {
    expect(isPublished(base, '2030-01-01T00:00:00Z')).toBe(false);
    expect(isPublished({ ...base, published_at: '2026-10-09T00:00:00Z' }, '2026-10-10T00:00:00Z')).toBe(true);
  });
  it('at_open: published from opens_at', () => {
    const s = { ...base, results_visibility: 'at_open' as const };
    expect(isPublished(s, '2026-10-01T11:59:59Z')).toBe(false);
    expect(isPublished(s, '2026-10-01T12:00:00Z')).toBe(true);
  });
  it('custom: published from results_visible_at', () => {
    const s = { ...base, results_visibility: 'custom' as const, results_visible_at: '2026-10-09T00:00:00Z' };
    expect(isPublished(s, '2026-10-08T23:59:59Z')).toBe(false);
    expect(isPublished(s, '2026-10-09T00:00:00Z')).toBe(true);
    expect(isPublished({ ...s, results_visible_at: null }, '2030-01-01T00:00:00Z')).toBe(false);
  });
  it('a manual publish wins over a future custom time', () => {
    const s = { ...base, results_visibility: 'custom' as const, results_visible_at: '2030-01-01T00:00:00Z', published_at: '2026-10-09T00:00:00Z' };
    expect(isPublished(s, '2026-10-10T00:00:00Z')).toBe(true);
  });
});
