// Second review fixes (BUILD_NOTES/09-second-review-fixes.md). The SQL side of the same cases is in
// supabase/tests/second_review.test.sql; the Deno side of item 4 and 5 is in supabase/functions/_shared/due.test.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildResultsQuestions,
  contribTeamsFromRows,
  questionProgress,
  studentsWithUnanswered,
  type ResultsQuestionInput,
  type ResultsResponseInput,
  type ResultsStudent,
} from './results';
import { buildResultsCsv } from './csv';
import { questionStats, contribStats } from './stats';
import { resolveRecipients, studentGiver, type RosterInstructor } from './recipients';
import { defaultSessionTimes, instantToLocalInputs, shownDeadline, studentDeadline } from './time';
import { answeredText, effectiveStatus, printedDeadline } from './studentView';
import { summarizeEmailLog } from './emailLog';
import type { EmailLog, RecipientType } from './types';

const st = (id: string, section: string, team: string, name: string): ResultsStudent => ({ id, section, team, name, email: `${id}@x.edu` });

// ---------------------------------------------------------------------------
// Item 2: contribution teams from the stored rows
// ---------------------------------------------------------------------------
describe('item 2: contribution results after a team change', () => {
  const before = [st('alice', 'S1', 'T1', 'Alice'), st('bob', 'S1', 'T1', 'Bob'), st('carol', 'S1', 'T1', 'Carol'), st('dave', 'S1', 'T2', 'Dave'), st('erin', 'S1', 'T2', 'Erin')];
  const after = [st('alice', 'S1', 'T1', 'Alice'), st('bob', 'S1', 'T1', 'Bob'), st('carol', 'S1', 'T2', 'Carol'), st('dave', 'S1', 'T1', 'Dave'), st('erin', 'S1', 'T2', 'Erin')];
  const t1ids = ['alice', 'bob', 'carol'];
  const ratings: [string, string, number][] = [
    ['alice', 'alice', 100], ['alice', 'bob', 120], ['alice', 'carol', 80],
    ['bob', 'alice', 110], ['bob', 'bob', 100], ['bob', 'carol', 90],
    ['carol', 'alice', 120], ['carol', 'bob', 110], ['carol', 'carol', 70],
  ];
  // rows as listResponses returns them: with the team stamped when each row was written
  const rows: ResultsResponseInput[] = ratings.map(([g, r, v], i) => ({
    id: `r${i}`, question_id: 'qc', giver_key: `s:${g}`, recipient_key: `s:${r}`, answer: { value: v }, giver_comment: null,
    updated_at: '2026-11-10T10:00:00Z', giver_team_key: 't:S1|T1', giver_team_ids: t1ids,
  }));
  const qc: ResultsQuestionInput = {
    id: 'qc', number: 1, type: 'contrib', brief: 'Contribution', details: { isZeroSum: true, isNotSureAllowed: false },
    giver_type: 'students', recipient_type: 'own_team_members_including_self', max_recipients: null,
  };
  const ccpc = (roster: ResultsStudent[]) => {
    const teams = contribTeamsFromRows('qc', rows, roster);
    const values = rows.map((r) => ({ giver_key: r.giver_key, recipient_key: r.recipient_key, value: (r.answer as { value: number }).value }));
    return contribStats(teams, values).rows.map((r) => `${r.team} ${r.name} ${r.claimed}/${r.perceived} [${r.ratings_received.join(',')}]`);
  };

  it('gives the review numbers before the move', () => {
    expect(ccpc(before).filter((x) => x.startsWith('T1'))).toEqual(['T1 Alice 100/107 [110,104]', 'T1 Bob 100/108 [120,96]', 'T1 Carol 70/85 [90,80]']);
  });

  it('gives the same numbers after Carol moves to T2 and Dave to T1 (the SQL test checks the same case)', () => {
    const t1 = (xs: string[]) => xs.filter((x) => x.startsWith('T1'));
    expect(t1(ccpc(after))).toEqual(t1(ccpc(before)));
    expect(ccpc(after).some((x) => x.includes('Dave'))).toBe(false);
    const teams = contribTeamsFromRows('qc', rows, after);
    expect(teams.map((t) => [t.team, t.members.map((m) => m.name)])).toEqual([['T1', ['Alice', 'Bob', 'Carol']], ['T2', ['Erin']]]);
  });

  it('the CSV statistics agree after the move', () => {
    const csvBefore = buildResultsCsv(buildResultsQuestions([qc], rows, before, [], { includeMissing: false }), { includeStats: true });
    const csvAfter = buildResultsCsv(buildResultsQuestions([qc], rows, after, [], { includeMissing: false }), { includeStats: true });
    // the statistics block sits between the "Team,Name,Email,CC,PC" header and the next blank row
    const statLines = (csv: string) => {
      const lines = csv.split('\r\n');
      const start = lines.findIndex((l) => l.includes('CC') && l.includes('PC') && l.includes('Ratings Received'));
      const end = lines.findIndex((l, i) => i > start && l.trim() === '');
      return lines.slice(start + 1, end).filter((l) => /^"?T1"?,/.test(l));
    };
    expect(statLines(csvBefore).length).toBe(3);
    expect(statLines(csvAfter)).toEqual(statLines(csvBefore));
    expect(statLines(csvAfter)).toEqual(['T1,Alice,alice@x.edu,100,107,110,104', 'T1,Bob,bob@x.edu,100,108,120,96', 'T1,Carol,carol@x.edu,70,85,90,80']);
  });

  it('a team with no responses uses the current roster; a deleted student is left out', () => {
    const teams = contribTeamsFromRows('qc', rows.filter((r) => r.giver_key !== 's:bob' && r.recipient_key !== 's:bob'), after.filter((s) => s.id !== 'bob'));
    expect(teams.map((t) => [t.team, t.members.map((m) => m.name)])).toEqual([['T1', ['Alice', 'Carol']], ['T2', ['Erin']]]);
    const none = contribTeamsFromRows('qc', [], after);
    expect(none.map((t) => [t.team, t.members.map((m) => m.name)])).toEqual([['T1', ['Alice', 'Bob', 'Dave']], ['T2', ['Carol', 'Erin']]]);
  });

  it('two givers with different stored member lists: the team is everyone either list names', () => {
    const roster = [st('g', 'S2', 'T4', 'Gina'), st('h', 'S2', 'T4', 'Hal'), st('k', 'S2', 'T4', 'Kim')];
    const grow: ResultsResponseInput[] = [
      { id: 'x1', question_id: 'qc', giver_key: 's:g', recipient_key: 's:g', answer: { value: 100 }, giver_comment: null, updated_at: '2026-11-10T10:00:00Z', giver_team_key: 't:S2|T4', giver_team_ids: ['g', 'h'] },
      { id: 'x2', question_id: 'qc', giver_key: 's:h', recipient_key: 's:k', answer: { value: 100 }, giver_comment: null, updated_at: '2026-11-11T10:00:00Z', giver_team_key: 't:S2|T4', giver_team_ids: ['g', 'h', 'k'] },
    ];
    expect(contribTeamsFromRows('qc', grow, roster).map((t) => t.members.map((m) => m.name))).toEqual([['Gina', 'Hal', 'Kim']]);
  });

  it('a giver whose own rows carry another team is in that team, whatever other rows say (latest own row wins)', () => {
    const roster = [st('a', 'S1', 'T1', 'A'), st('b', 'S1', 'T2', 'B')];
    const moved: ResultsResponseInput[] = [
      { id: '1', question_id: 'qc', giver_key: 's:a', recipient_key: 's:a', answer: { value: 100 }, giver_comment: null, updated_at: '2026-11-10T10:00:00Z', giver_team_key: 't:S1|T1', giver_team_ids: ['a', 'b'] },
      { id: '2', question_id: 'qc', giver_key: 's:b', recipient_key: 's:b', answer: { value: 100 }, giver_comment: null, updated_at: '2026-11-11T10:00:00Z', giver_team_key: 't:S1|T2', giver_team_ids: ['b'] },
    ];
    expect(contribTeamsFromRows('qc', moved, roster).map((t) => [t.team, t.members.map((m) => m.name)])).toEqual([['T1', ['A']], ['T2', ['B']]]);
  });

  it('rows without stored teams (older reads) behave as the current roster', () => {
    const bare = rows.map(({ giver_team_key: _k, giver_team_ids: _i, ...r }) => r);
    const teams = contribTeamsFromRows('qc', bare, after);
    expect(teams.find((t) => t.team === 'T1')!.members.map((m) => m.name)).toEqual(['Alice', 'Bob', 'Dave']);
    expect(questionStats('contrib', qc.details, [], teams)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Item 3: the deadline students see
// ---------------------------------------------------------------------------
describe('item 3: shown deadline', () => {
  const s = { opens_at: '2026-11-01T00:00:00Z', closes_at: '2026-11-20T06:59:00Z', grace_minutes: 15 };
  it('is the close time without grace, or the extension', () => {
    expect(new Date(shownDeadline(s)).toISOString()).toBe('2026-11-20T06:59:00.000Z');
    expect(new Date(studentDeadline(s)).toISOString()).toBe('2026-11-20T07:14:00.000Z');
    expect(new Date(shownDeadline(s, '2026-11-22T06:59:00Z')).toISOString()).toBe('2026-11-22T06:59:00.000Z');
  });
  it('printedDeadline prefers shown_deadline and falls back for older payloads', () => {
    expect(printedDeadline({ deadline: 'D', shown_deadline: 'S' })).toBe('S');
    expect(printedDeadline({ deadline: 'D' })).toBe('D');
  });
  it('effectiveStatus: past the printed deadline but before the cutoff is the late period', () => {
    const cutoff = '2026-11-20T07:14:00Z';
    const shown = '2026-11-20T06:59:00Z';
    expect(effectiveStatus('open', cutoff, '2026-11-20T06:58:00Z', shown)).toBe('open');
    expect(effectiveStatus('open', cutoff, '2026-11-20T07:00:00Z', shown)).toBe('grace');
    expect(effectiveStatus('open', cutoff, '2026-11-20T07:14:00Z', shown)).toBe('closed');
    expect(effectiveStatus('open', cutoff, '2026-11-20T07:00:00Z')).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// Item 4: questions answered
// ---------------------------------------------------------------------------
interface Fixture {
  rosters: Record<string, { id: string; section: string; team: string }[]>;
  cases: { roster: string; giver: string; recipient_type: RecipientType; instructors: number; expected: boolean }[];
}

describe('item 4: questions answered out of questions the student can answer', () => {
  it('resolveRecipients agrees with the shared fixture used by hasRecipients in due.ts', () => {
    const fx = JSON.parse(readFileSync(resolve(process.cwd(), '../supabase/tests/fixtures/has_recipients_cases.json'), 'utf8')) as Fixture;
    for (const c of fx.cases) {
      const roster = fx.rosters[c.roster].map((r) => ({ ...r, name: r.id }));
      const ins: RosterInstructor[] = [
        ...Array.from({ length: c.instructors }, (_, i) => ({ id: `i${i}`, display_name: `I${i}`, is_displayed_to_students: true })),
        { id: 'hidden', display_name: 'Hidden', is_displayed_to_students: false },
      ];
      const me = roster.find((r) => r.id === c.giver)!;
      const got = resolveRecipients({ giver_type: 'students', recipient_type: c.recipient_type }, studentGiver(me), roster, ins).length > 0;
      expect(got, `${c.roster}/${c.giver}/${c.recipient_type}`).toBe(c.expected);
    }
  });

  const roster = [st('alice', 'S1', 'T1', 'Alice'), st('bob', 'S1', 'T1', 'Bob'), st('frank', 'S2', 'T3', 'Frank')];
  const ins: RosterInstructor[] = [{ id: 'i1', display_name: 'Prof', is_displayed_to_students: true }];
  const qs = [
    { id: 'q1', giver_type: 'students' as const, recipient_type: 'own_team_members' as const },
    { id: 'q2', giver_type: 'students' as const, recipient_type: 'self' as const },
    { id: 'q3', giver_type: 'instructors' as const, recipient_type: 'students' as const },
    { id: 'q4', giver_type: 'students' as const, recipient_type: 'instructors' as const },
  ];
  const rows = [{ question_id: 'q1', giver_key: 's:alice' }, { question_id: 'q2', giver_key: 's:frank' }, { question_id: 'q3', giver_key: 'i:i1' }];

  it('counts like the SQL portal test (Alice 1 of 3, Frank 1 of 2 as a team of one)', () => {
    const p = questionProgress(qs, roster, ins, rows);
    expect([p.get('alice')!.answered, p.get('alice')!.answerable]).toEqual([1, 3]);
    expect(p.get('alice')!.unanswered).toEqual(['q2', 'q4']);
    expect([p.get('frank')!.answered, p.get('frank')!.answerable]).toEqual([1, 2]);
    expect([p.get('bob')!.answered, p.get('bob')!.answerable]).toEqual([0, 3]);
    const hidden = questionProgress(qs, roster, [{ ...ins[0], is_displayed_to_students: false }], rows);
    expect(hidden.get('alice')!.answerable).toBe(2);
  });

  it('studentsWithUnanswered selects anyone with an unanswered question; a student who answered all is left out', () => {
    const all = [...rows, { question_id: 'q2', giver_key: 's:alice' }, { question_id: 'q4', giver_key: 's:alice' }];
    const p = questionProgress(qs, roster, ins, all);
    expect(studentsWithUnanswered(roster, p).map((s) => s.id)).toEqual(['bob', 'frank']);
  });

  it('answeredText for the student portal', () => {
    expect(answeredText(3, 5)).toBe('3 of 5 questions answered');
    expect(answeredText(1, 1)).toBe('1 of 1 question answered');
    expect(answeredText(0, 0)).toBe('No questions for you');
    expect(answeredText(undefined, 3)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Item 5: email results on the Status page
// ---------------------------------------------------------------------------
describe('item 5: email log summary', () => {
  const row = (kind: string, status: EmailLog['status'], student: string, at: string, error: string | null = null): EmailLog => ({
    id: `${kind}${student}${at}`, session_id: 's1', kind, to_email: `${student}@x.edu`, student_id: student, status, error, created_at: at,
  });
  const rows = [
    row('opened', 'failed', 'a', '2026-11-10T10:00:00Z', 'domain is not verified'),
    row('opened', 'sent', 'a', '2026-11-10T10:15:00Z'),
    row('opened', 'failed', 'b', '2026-11-10T10:00:00Z', 'mailbox full'),
    row('published', 'skipped', 'a', '2026-11-12T10:00:00Z', 'RESEND_API_KEY not set'),
    row('reminder', 'sent', 'b', '2026-11-11T10:00:00Z'),
  ];
  it('counts by kind and status in a fixed order', () => {
    const s = summarizeEmailLog(rows);
    expect(s.total).toBe(5);
    expect(s.byKind.map((k) => [k.label, k.counts.sent, k.counts.failed, k.counts.skipped])).toEqual([
      ['Session opened', 1, 2, 0], ['Results published', 0, 0, 1], ['Reminder', 1, 0, 0],
    ]);
  });
  it('lists failures with address and error, newest first, and marks the ones sent later', () => {
    const f = summarizeEmailLog(rows).failures;
    expect(f.map((x) => [x.to_email, x.error, x.resolved])).toEqual([['a@x.edu', 'domain is not verified', true], ['b@x.edu', 'mailbox full', false]]);
  });
});

// ---------------------------------------------------------------------------
// Item 6: default times (new session and copy)
// ---------------------------------------------------------------------------
describe('item 6: default session times', () => {
  it('opens tomorrow at 08:00 and closes eight days from today at 23:59 in the course time zone', () => {
    const now = Date.parse('2026-11-17T20:00:00Z'); // 2026-11-18 05:00 in Tokyo
    const t = defaultSessionTimes('Asia/Tokyo', now);
    expect(instantToLocalInputs(t.opens, 'Asia/Tokyo')).toEqual({ date: '2026-11-19', time: '08:00' });
    expect(instantToLocalInputs(t.closes, 'Asia/Tokyo')).toEqual({ date: '2026-11-26', time: '23:59' });
    const d = defaultSessionTimes('America/Denver', now); // 13:00 on 2026-11-17 in Denver
    expect(instantToLocalInputs(d.opens, 'America/Denver')).toEqual({ date: '2026-11-18', time: '08:00' });
    expect(instantToLocalInputs(d.closes, 'America/Denver')).toEqual({ date: '2026-11-25', time: '23:59' });
  });
});
