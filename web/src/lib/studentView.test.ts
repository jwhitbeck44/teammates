import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './errors';
import {
  NETWORK_MESSAGE,
  UNKNOWN_MESSAGE,
  contribFigureText,
  contribSummaryLines,
  effectiveStatus,
  groupResults,
  mapRpcError,
  resultGroup,
  resultRowTitle,
  timeLeftText,
} from './studentView';
import { ERROR_MESSAGES } from './errors';

describe('mapRpcError', () => {
  it('maps every known code from a PostgREST error', () => {
    for (const code of ERROR_CODES) {
      const m = mapRpcError({ message: code, details: '', code: 'P0001' });
      expect(m.code).toBe(code);
      expect(m.message).toBe(ERROR_MESSAGES[code]);
    }
  });
  it('reads the recipient key from details', () => {
    expect(mapRpcError({ message: 'sum_mismatch', details: 's:abc' }).recipient_key).toBe('s:abc');
    expect(mapRpcError({ message: 'sum_mismatch', details: 'none' }).recipient_key).toBe('none');
    expect(mapRpcError({ message: 'sum_mismatch', details: 'something else' }).recipient_key).toBeNull();
    expect(mapRpcError({ message: 'sum_mismatch', details: '' }).recipient_key).toBeNull();
  });
  it('maps the student access codes to the planned text', () => {
    expect(mapRpcError({ message: 'invalid_token' }).code).toBe('invalid_token');
    expect(mapRpcError({ message: 'not_open_yet' }).message).toBe('This session is not open yet.');
    expect(mapRpcError({ message: 'deadline_passed' }).message).toBe('The deadline for this session has passed.');
    expect(mapRpcError({ message: 'not_published' }).code).toBe('not_published');
  });
  it('maps network failures', () => {
    expect(mapRpcError(new TypeError('Failed to fetch'))).toMatchObject({ code: 'network', message: NETWORK_MESSAGE });
    expect(mapRpcError({ message: 'NetworkError when attempting to fetch resource.' }).code).toBe('network');
  });
  it('gives raw database text a generic message', () => {
    const m = mapRpcError({ message: 'relation "x" does not exist', code: '42P01' });
    expect(m).toEqual({ code: 'unknown', message: UNKNOWN_MESSAGE, recipient_key: null });
    expect(mapRpcError(null).code).toBe('unknown');
    expect(mapRpcError(undefined).message).toBe(UNKNOWN_MESSAGE);
  });
  it('keeps an already mapped error', () => {
    const m = mapRpcError({ message: 'The deadline for this session has passed.', code: 'deadline_passed', recipient_key: 's:1' });
    expect(m).toEqual({ code: 'deadline_passed', message: 'The deadline for this session has passed.', recipient_key: 's:1' });
  });
});

describe('status and time', () => {
  const deadline = '2026-11-20T12:00:00Z';
  it('turns open into closed once the deadline has passed', () => {
    expect(effectiveStatus('open', deadline, '2026-11-20T11:59:00Z')).toBe('open');
    expect(effectiveStatus('open', deadline, '2026-11-20T12:00:00Z')).toBe('closed');
    expect(effectiveStatus('grace', deadline, '2026-11-20T11:00:00Z')).toBe('grace');
    expect(effectiveStatus('closed', deadline, '2026-11-01T00:00:00Z')).toBe('closed');
  });
  it('words the time left', () => {
    expect(timeLeftText(deadline, '2026-11-18T09:00:00Z')).toBe('2 days 3 h left');
    expect(timeLeftText(deadline, '2026-11-20T09:30:00Z')).toBe('2 h 30 min left');
    expect(timeLeftText(deadline, '2026-11-20T11:15:00Z')).toBe('45 min left');
    expect(timeLeftText(deadline, '2026-11-20T11:59:30Z')).toBe('Less than a minute left');
    expect(timeLeftText(deadline, '2026-11-20T12:00:00Z')).toBe('');
  });
});

describe('results grouping', () => {
  const rows = [
    { giver_name: 'Anonymous', recipient_name: 'Me', answer: {}, giver_comment: null, is_own: false, recipient_is_me: true },
    { giver_name: 'Me', recipient_name: 'Bo', answer: {}, giver_comment: null, is_own: true, recipient_is_me: false },
    { giver_name: 'Me', recipient_name: 'Me', answer: {}, giver_comment: null, is_own: true, recipient_is_me: true },
    { giver_name: 'Cy', recipient_name: 'Di', answer: {}, giver_comment: null, is_own: false, recipient_is_me: false },
  ];
  it('puts own answers under "You gave", answers about the student under "About you", the rest under "Others"', () => {
    expect(rows.map(resultGroup)).toEqual(['about_you', 'you_gave', 'you_gave', 'others']);
    const g = groupResults(rows);
    expect(g.map((x) => [x.title, x.rows.length])).toEqual([
      ['About you', 1],
      ['You gave', 2],
      ['Others', 1],
    ]);
  });
  it('leaves out empty groups', () => {
    expect(groupResults([rows[3]]).map((x) => x.id)).toEqual(['others']);
    expect(groupResults([])).toEqual([]);
  });
  it('titles rows with Anonymous kept as is', () => {
    expect(resultRowTitle('about_you', rows[0])).toBe('From Anonymous');
    expect(resultRowTitle('you_gave', rows[1])).toBe('To Bo');
    expect(resultRowTitle('others', rows[3])).toBe('Cy to Di');
    expect(resultRowTitle('others', { giver_name: 'Cy', recipient_name: '(no recipient)' })).toBe('Cy');
    expect(resultRowTitle('you_gave', { giver_name: 'Me', recipient_name: '(no recipient)' })).toBe('Your answer');
  });
});

describe('contribution summary', () => {
  it('uses Equal share wording and words for the special values', () => {
    expect(contribFigureText(110)).toBe('Equal share + 10%');
    expect(contribFigureText(100)).toBe('Equal share');
    expect(contribFigureText(95)).toBe('Equal share - 5%');
    expect(contribFigureText(-101)).toBe('Not Sure');
    expect(contribFigureText(-999)).toBe('Not submitted');
    expect(contribFigureText(-9999)).toBe('Not available');
  });
  it('builds "Your claim" and "Your team\'s view of you"', () => {
    const out = contribSummaryLines({
      my_claim: { own: 110, others: [100, 90] },
      team_view_of_me: { own: 100, others: [105] },
    });
    expect(out.map((b) => b.heading)).toEqual(['Your claim', "Your team's view of you"]);
    expect(out[0].lines).toEqual(['You: Equal share + 10%', 'Your teammates: Equal share, Equal share - 10%']);
    expect(out[1].lines).toEqual(['You: Equal share', 'Your teammates: Equal share + 5%']);
  });
});
