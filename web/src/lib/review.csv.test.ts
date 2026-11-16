// Independent review: every cell of every CSV the app can export is formula-safe, even when
// student-controlled text (names, teams, answers, comments) and instructor text (briefs, options) are hostile.
import { describe, expect, it } from 'vitest';
import {
  buildNonSubmitterCsv,
  buildResultsCsv,
  buildRosterCsv,
  buildStudentLinksCsv,
  neutralizeFormula,
  parseCsv,
  type ResultsParty,
  type ResultsQuestion,
} from './csv';

const EVIL = ['=HYPERLINK("http://x","y")', '+1+1', '@SUM(1)', '-2+3', '\t=1', '\r=1', "=cmd|' /C calc'!A0"];
const party = (id: string, name: string, team: string): ResultsParty => ({ key: `s:${id}`, name, email: `${id}@x.edu`, team, team_key: `t:A|${team}` });

// A cell is unsafe when a spreadsheet would read it as a formula: starts with = + @ TAB CR, or with - unless the
// whole cell is a plain number.
const unsafe = (c: string): boolean => /^[=+@\t\r]/.test(c) || (/^-/.test(c) && !/^-[\d.]+$/.test(c));

describe('review: CSV formula injection', () => {
  it('neutralizeFormula handles each hostile start', () => {
    for (const e of EVIL) expect(unsafe(neutralizeFormula(e))).toBe(false);
    expect(neutralizeFormula('-5')).toBe('-5');
  });

  it('results CSV: no cell of any type starts like a formula', () => {
    const a = party('a', EVIL[0], EVIL[1]);
    const b = party('b', EVIL[2], EVIL[3]);
    const mk = (type: ResultsQuestion['type'], details: unknown, answer: unknown): ResultsQuestion => ({
      number: 1,
      brief: EVIL[0],
      type,
      details,
      responses: [
        { giver: a, recipient: b, answer, giver_comment: EVIL[4] },
        { giver: b, recipient: a, answer, giver_comment: null },
      ],
    });
    const qs: ResultsQuestion[] = [
      mk('text', {}, { text: EVIL[0] }),
      mk('mcq', { choices: [EVIL[1], 'B'], otherEnabled: true }, { other: EVIL[2] }),
      mk('mcq', { choices: [EVIL[1], 'B'], otherEnabled: true }, { choice: EVIL[1] }),
      mk('msq', { choices: [EVIL[1], EVIL[2]], otherEnabled: true }, { choices: [EVIL[1]], other: EVIL[0] }),
      mk('numscale', { min: 1, max: 5, step: 1 }, { value: 3 }),
      mk('constsum_options', { options: [EVIL[0], EVIL[1]], points: 10, pointsPerOption: false, distribute: 'none' }, { points: [5, 5] }),
      mk('rubric', { choices: [EVIL[0], 'b'], subQuestions: [EVIL[1]], descriptions: [['x', 'y']] }, { choices: [0] }),
      mk('rank_options', { options: [EVIL[0], EVIL[1]], duplicatesAllowed: false }, { ranks: [1, 2] }),
      mk('rank_recipients', { duplicatesAllowed: false }, { rank: 1 }),
      mk('constsum_recipients', { points: 10, pointsPerOption: false, distribute: 'none' }, { points: 5 }),
    ];
    const bad: string[] = [];
    for (const [i, q] of qs.entries()) {
      q.number = i + 1;
      const rows = parseCsv(buildResultsCsv([q], { includeStats: true }));
      for (const r of rows) for (const c of r) if (unsafe(c)) bad.push(`${q.type}: ${JSON.stringify(c)}`);
    }
    expect(bad).toEqual([]);
  });

  it('links and non-submitter CSVs are formula-safe', () => {
    const students = [{ section: EVIL[0], team: EVIL[1], name: EVIL[2], email: EVIL[3], token: 'tok', comments: null }];
    for (const text of [buildStudentLinksCsv(students, 'https://x.github.io/app'), buildNonSubmitterCsv(students), buildRosterCsv(students)]) {
      for (const r of parseCsv(text)) for (const c of r) expect(unsafe(c)).toBe(false);
    }
  });
});
