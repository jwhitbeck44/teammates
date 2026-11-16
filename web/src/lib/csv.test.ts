import { describe, expect, it } from 'vitest';
import {
  ResultsParty,
  ResultsQuestion,
  answerCells,
  answerColumnHeaders,
  buildNonSubmitterCsv,
  buildResultsCsv,
  buildRosterCsv,
  buildStudentLinksCsv,
  neutralizeFormula,
  parseCsv,
  parseRosterCsv,
  studentLink,
  toCsv,
} from './csv';

const party = (id: string, name: string, team = 'T1'): ResultsParty => ({ key: `s:${id}`, name, email: `${name.toLowerCase()}@x.edu`, team, team_key: `t:A|${team}` });
const ann = party('1', 'Ann');
const bob = party('2', 'Bob');

describe('toCsv and parseCsv', () => {
  it('quotes cells with commas, quotes and line breaks and joins rows with CRLF', () => {
    expect(toCsv([['a', 'b,c', 'say "hi"', 'two\nlines'], ['x']])).toBe('a,"b,c","say ""hi""","two\nlines"\r\nx');
  });
  it('round-trips awkward cells', () => {
    const rows = [
      ['Section', 'Team', 'Name'],
      ['A', 'Team, "One"', 'Line1\nLine2'],
      ['', ' spaced ', 'tab\there'],
      ['é', '日本語', '😀'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it('reads LF, CRLF and CR line ends, a BOM and a missing final newline', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('a,b\rc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('﻿a,b')).toEqual([['a', 'b']]);
    expect(parseCsv('')).toEqual([]);
  });
  it('keeps empty cells and handles a quoted empty string', () => {
    expect(parseCsv('a,,c\n"",x,')).toEqual([['a', '', 'c'], ['', 'x', '']]);
  });
  it('switches to tabs for pasted spreadsheet cells', () => {
    expect(parseCsv('a\tb\tc\n1\t2\t3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });
  it('neutralizes formula-like cells only on request', () => {
    expect(toCsv([['=1+1']])).toBe('=1+1');
    expect(toCsv([['=1+1', '+x', '@y', '-abc', '-5', '-0.5', 'ok']], { neutralize: true })).toBe("'=1+1,'+x,'@y,'-abc,-5,-0.5,ok");
    expect(neutralizeFormula('-101')).toBe('-101');
  });
});

describe('parseRosterCsv', () => {
  it('reads rows without a header in the order Section, Team, Name, Email, Comments', () => {
    const r = parseRosterCsv('S1,Red,Ann Lee,Ann@X.edu,nice\nS1,Red,Bob,bob@x.edu,');
    expect(r.hadHeader).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { row: 1, section: 'S1', team: 'Red', name: 'Ann Lee', email: 'ann@x.edu', comments: 'nice' },
      { row: 2, section: 'S1', team: 'Red', name: 'Bob', email: 'bob@x.edu', comments: '' },
    ]);
    expect(r.valid).toHaveLength(2);
  });
  it('reads a header, in any case, and maps columns by name', () => {
    const r = parseRosterCsv('email,NAME,team\nann@x.edu,Ann,Red');
    expect(r.hadHeader).toBe(true);
    expect(r.rows[0]).toEqual({ row: 1, section: 'Default Section', team: 'Red', name: 'Ann', email: 'ann@x.edu', comments: '' });
  });
  it('reads the standard header row', () => {
    const r = parseRosterCsv(toCsv([['Section', 'Team', 'Name', 'Email', 'Comments'], ['S1', 'Red', 'Ann', 'a@x.edu', 'c']]));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].comments).toBe('c');
  });
  it('fills Default Section and Default Team and squashes spaces', () => {
    const r = parseRosterCsv(',, Ann   Lee ,a@x.edu,');
    expect(r.rows[0]).toMatchObject({ section: 'Default Section', team: 'Default Team', name: 'Ann Lee' });
  });
  it('handles quoted fields with commas and line breaks', () => {
    const r = parseRosterCsv('S1,"Team, A","Lee, Ann",a@x.edu,"line1\nline2"');
    expect(r.rows[0].team).toBe('Team, A');
    expect(r.rows[0].name).toBe('Lee, Ann');
    expect(r.rows[0].comments).toBe('line1\nline2');
  });
  it('accepts tab-separated paste', () => {
    const r = parseRosterCsv('S1\tRed\tAnn\ta@x.edu\t');
    expect(r.rows[0].name).toBe('Ann');
  });
  it('skips blank rows but keeps row numbers aligned with the source', () => {
    const r = parseRosterCsv('S1,Red,Ann,a@x.edu,\n\n,,,,\nS1,Red,Bob,nope');
    expect(r.rows.map((x) => x.row)).toEqual([1, 4]);
    expect(r.errors.map((e) => [e.row, e.code])).toEqual([[4, 'invalid_email']]);
  });
  it('reports required fields', () => {
    const r = parseRosterCsv('S1,Red,,a@x.edu\nS1,Red,Bob,');
    expect(r.errors.map((e) => [e.row, e.code, e.field])).toEqual([[1, 'required_field_missing', 'name'], [2, 'required_field_missing', 'email']]);
    expect(r.valid).toEqual([]);
  });
  it('reports limits from spec section j', () => {
    const long = (n: number) => 'x'.repeat(n);
    const r = parseRosterCsv(
      [
        `${long(61)},Red,Ann,a1@x.edu`, // section
        `S,${long(61)},Ann,a2@x.edu`, // team
        `S,Red,${long(101)},a3@x.edu`, // name
        `S,Red,Ann,${long(250)}@x.edu`, // email
        `S,Red,Ann,a5@x.edu,${long(501)}`, // comments
        'S,Re|d,Ann,a6@x.edu', // forbidden char
        'S,50%,Ann,a7@x.edu',
        'S,team@x.edu,Ann,a8@x.edu', // team looks like email
        'S,Red,Ann,not an email',
      ].join('\n'),
    );
    expect(r.errors.map((e) => `${e.row}:${e.code}:${e.field}`)).toEqual([
      '1:too_long:section',
      '2:too_long:team',
      '3:too_long:name',
      '4:too_long:email',
      '5:too_long:comments',
      '6:forbidden_char:team',
      '7:forbidden_char:team',
      '8:team_looks_like_email:team',
      '9:invalid_email:email',
    ]);
  });
  it('exact limits are accepted', () => {
    const r = parseRosterCsv(`${'s'.repeat(60)},${'t'.repeat(60)},${'n'.repeat(100)},a@x.edu,${'c'.repeat(500)}`);
    expect(r.errors).toEqual([]);
  });
  it('flags a repeated email, case-insensitively, on the later rows', () => {
    const r = parseRosterCsv('S,R,Ann,a@x.edu\nS,R,Ann2,A@X.EDU\nS,R,Bob,b@x.edu');
    expect(r.errors.map((e) => [e.row, e.code])).toEqual([[2, 'duplicate_email']]);
    expect(r.valid.map((x) => x.row)).toEqual([1, 3]);
  });
  it('flags rows beyond 100 students in a section, counting existing students not updated here', () => {
    const lines = Array.from({ length: 101 }, (_, i) => `Big,T,N${i},s${i}@x.edu`).join('\n');
    const r = parseRosterCsv(lines);
    expect(r.errors.map((e) => [e.row, e.code])).toEqual([[101, 'section_too_large']]);

    const existing = Array.from({ length: 99 }, (_, i) => ({ email: `old${i}@x.edu`, section: 'Big' }));
    const r2 = parseRosterCsv('Big,T,A,a@x.edu\nBig,T,B,b@x.edu', { existing });
    expect(r2.errors.map((e) => [e.row, e.code])).toEqual([[2, 'section_too_large']]);
    // An existing student who is updated by the input is not counted twice.
    const r3 = parseRosterCsv('Big,T,A,OLD0@x.edu\nBig,T,B,b@x.edu', { existing });
    expect(r3.errors).toEqual([]);
  });
  it('reports a header without a Name or Email column on row 0', () => {
    const r = parseRosterCsv('Section,Team,Email\nS,R,a@x.edu');
    expect(r.errors).toEqual([expect.objectContaining({ row: 0, code: 'required_field_missing', field: 'name' })]);
    expect(r.rows).toEqual([]);
  });
  it('reports extra columns', () => {
    const r = parseRosterCsv('S,R,Ann,a@x.edu,c,extra');
    expect(r.errors.map((e) => e.code)).toEqual(['wrong_column_count']);
    expect(parseRosterCsv('S,R,Ann,a@x.edu,c,').errors).toEqual([]);
  });
  it('round-trips with buildRosterCsv', () => {
    const students = [
      { section: 'S1', team: 'Team, One', name: 'Ann "A" Lee', email: 'ann@x.edu', comments: 'a\nb' },
      { section: 'S2', team: 'Blue', name: 'Bob', email: 'bob@x.edu', comments: '' },
    ];
    const r = parseRosterCsv(buildRosterCsv(students));
    expect(r.hadHeader).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.rows.map(({ row: _row, ...rest }) => rest)).toEqual(students);
  });
  it('returns nothing for empty input', () => {
    expect(parseRosterCsv('')).toEqual({ rows: [], valid: [], errors: [], hadHeader: false });
  });
});

describe('student links CSV', () => {
  it('builds links as <app>/#/s/<token>', () => {
    expect(studentLink('https://x.github.io/app/', 'tok')).toBe('https://x.github.io/app/#/s/tok');
    expect(studentLink('https://x.github.io/app', 'tok')).toBe('https://x.github.io/app/#/s/tok');
  });
  it('writes Section, Team, Name, Email, Link and parses back', () => {
    const csv = buildStudentLinksCsv(
      [
        { section: 'S1', team: 'Red', name: 'Ann', email: 'ann@x.edu', token: 'abc-_123' },
        { section: 'S1', team: 'Red', name: '=SUM(A1)', email: 'bob@x.edu', token: 'def' },
      ],
      'https://app.example',
    );
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(['Section', 'Team', 'Name', 'Email', 'Link']);
    expect(rows[1]).toEqual(['S1', 'Red', 'Ann', 'ann@x.edu', 'https://app.example/#/s/abc-_123']);
    expect(rows[2][2]).toBe("'=SUM(A1)");
  });
});

describe('non-submitter CSV', () => {
  it('lists Team, Name, Email and is empty when everyone submitted', () => {
    expect(buildNonSubmitterCsv([])).toBe('');
    const rows = parseCsv(buildNonSubmitterCsv([{ team: 'Red', name: 'Ann', email: 'ann@x.edu' }]));
    expect(rows).toEqual([['Participants who have not responded to any question'], [''], ['Team', 'Name', 'Email'], ['Red', 'Ann', 'ann@x.edu']]);
  });
});

describe('results CSV', () => {
  const textQ: ResultsQuestion = {
    number: 2,
    brief: 'Comments?',
    type: 'text',
    details: {},
    responses: [
      { giver: bob, recipient: ann, answer: { text: 'Great, really' }, giver_comment: null },
      { giver: ann, recipient: bob, answer: null, giver_comment: null },
      { giver: ann, recipient: ann, answer: { text: '=cmd' }, giver_comment: 'my comment' },
    ],
  };
  const header = ['Team', "Giver's Name", "Giver's Email", "Recipient's Team", "Recipient's Name", "Recipient's Email", 'Feedback', "Giver's Comment"];

  it('uses the TEAMMATES layout: blank rows, question row, header, sorted responses', () => {
    const rows = parseCsv(buildResultsCsv([textQ]));
    expect(rows.slice(0, 4)).toEqual([[''], [''], ['Question 2', 'Comments?'], ['']]);
    expect(rows[4]).toEqual(header);
    // sorted by giver team, giver, recipient team, recipient
    expect(rows[5]).toEqual(['T1', 'Ann', 'ann@x.edu', 'T1', 'Ann', 'ann@x.edu', "'=cmd", 'my comment']);
    expect(rows[6]).toEqual(['T1', 'Ann', 'ann@x.edu', 'T1', 'Bob', 'bob@x.edu', 'No Response', '']);
    expect(rows[7]).toEqual(['T1', 'Bob', 'bob@x.edu', 'T1', 'Ann', 'ann@x.edu', 'Great, really', '']);
    expect(rows.slice(8)).toEqual([['']]); // two blank rows at the end; the last line break closes the final row
  });
  it('can drop missing responses', () => {
    const rows = parseCsv(buildResultsCsv([textQ], { indicateMissing: false }));
    expect(rows.some((r) => r.includes('No Response'))).toBe(false);
  });
  it('adds section rows and sorts questions by number', () => {
    const q1: ResultsQuestion = { ...textQ, number: 1, brief: 'First', responses: [] };
    const rows = parseCsv(buildResultsCsv([textQ, q1], { sectionName: 'Sec A', sectionDetail: 'Evaluees' }));
    expect(rows[0]).toEqual(['Section Name', 'Sec A']);
    expect(rows[1]).toEqual(['Section View Detail', 'Evaluees']);
    const qRows = rows.filter((r) => r[0].startsWith('Question'));
    expect(qRows.map((r) => r[0])).toEqual(['Question 1', 'Question 2']);
  });
  it('writes a stats block when asked (numscale)', () => {
    const q: ResultsQuestion = {
      number: 1,
      brief: 'Rate',
      type: 'numscale',
      details: { min: 1, max: 5, step: 1 },
      responses: [
        { giver: ann, recipient: ann, answer: { value: 5 }, giver_comment: null },
        { giver: bob, recipient: ann, answer: { value: 3 }, giver_comment: null },
      ],
    };
    const rows = parseCsv(buildResultsCsv([q], { includeStats: true }));
    const at = rows.findIndex((r) => r[0] === 'Summary Statistics');
    expect(at).toBeGreaterThan(0);
    expect(rows[at + 1]).toEqual(['Team', 'Recipient', 'Recipient Email', 'Average', 'Minimum', 'Maximum', 'Average excluding self response']);
    expect(rows[at + 2]).toEqual(['T1', 'Ann', 'ann@x.edu', '4', '3', '5', '3']);
    expect(parseCsv(buildResultsCsv([q])).some((r) => r[0] === 'Summary Statistics')).toBe(false);
  });
  it('writes the contrib legend and CC, PC rows with "Equal share" answer text', () => {
    const members = [ann, bob];
    const q: ResultsQuestion = {
      number: 1,
      brief: 'Work',
      type: 'contrib',
      details: { isZeroSum: true, isNotSureAllowed: false },
      contribMembers: members,
      responses: [
        { giver: ann, recipient: ann, answer: { value: 110 }, giver_comment: null },
        { giver: ann, recipient: bob, answer: { value: 90 }, giver_comment: null },
        { giver: bob, recipient: ann, answer: { value: 100 }, giver_comment: null },
        { giver: bob, recipient: bob, answer: { value: 100 }, giver_comment: null },
      ],
    };
    const rows = parseCsv(buildResultsCsv([q], { includeStats: true }));
    const h = rows.findIndex((r) => r[0] === 'Team' && r[3] === 'CC');
    expect(rows[h]).toEqual(['Team', 'Name', 'Email', 'CC', 'PC', 'Ratings Received']);
    expect(rows[h + 1].slice(0, 3)).toEqual(['T1', 'Ann', 'ann@x.edu']);
    expect(rows.some((r) => r[6] === 'Equal share + 10%')).toBe(true);
    expect(rows.some((r) => r[6] === 'Equal share - 10%')).toBe(true);
    expect(rows.some((r) => r[6] === 'Equal share')).toBe(true);
  });
});

describe('answer columns per type', () => {
  it('headers', () => {
    expect(answerColumnHeaders('text', {})).toEqual(['Feedback']);
    expect(answerColumnHeaders('mcq', { choices: ['a'] })).toEqual(['Feedback']);
    expect(answerColumnHeaders('msq', { choices: ['a', 'b'] })).toEqual(['Feedback', 'a', 'b']);
    expect(answerColumnHeaders('constsum_options', { options: ['x', 'y'] })).toEqual(['Feedback', 'x', 'y']);
    expect(answerColumnHeaders('rank_options', { options: ['x', 'y', 'z'] })).toEqual(['Feedback', 'Rank 1', 'Rank 2', 'Rank 3']);
    expect(answerColumnHeaders('rubric', {})).toEqual(['Sub Question', 'Choice Value', 'Choice Number']);
    expect(answerColumnHeaders('rank_recipients', {})).toEqual(['Feedback']);
  });
  it('cells', () => {
    expect(answerCells('mcq', {}, { choice: 'a' })).toEqual([['a']]);
    expect(answerCells('mcq', {}, { other: 'zzz' })).toEqual([['zzz']]);
    expect(answerCells('msq', { choices: ['a', 'b', 'c'] }, { choices: ['a', 'c'], other: 'o' })).toEqual([['o', 'a', '', 'c']]);
    expect(answerCells('constsum_options', {}, { points: [60, 40] })).toEqual([['', '60', '40']]);
    expect(answerCells('constsum_recipients', {}, { points: 110 })).toEqual([['110']]);
    expect(answerCells('numscale', {}, { value: 2.5 })).toEqual([['2.5']]);
    expect(answerCells('rank_recipients', {}, { rank: 2 })).toEqual([['2']]);
    expect(answerCells('rank_options', { options: ['x', 'y', 'z'] }, { ranks: [2, 1, 2] })).toEqual([['', 'y', 'x, z', '']]);
    expect(answerCells('rubric', { choices: ['Poor', 'Good'] }, { choices: [1, -1] })).toEqual([
      ['a', 'Good', '2'],
      ['b', 'No Response', ''],
    ]);
  });
  it('a rubric response writes one row per sub-question and a missing one writes All Sub-Questions', () => {
    const q: ResultsQuestion = {
      number: 1,
      brief: 'Rubric',
      type: 'rubric',
      details: { choices: ['Poor', 'Good'], subQuestions: ['s1', 's2'], descriptions: [['', ''], ['', '']] },
      responses: [
        { giver: ann, recipient: bob, answer: { choices: [0, 1] }, giver_comment: null },
        { giver: bob, recipient: ann, answer: null, giver_comment: null },
      ],
    };
    const rows = parseCsv(buildResultsCsv([q]));
    const h = rows.findIndex((r) => r[0] === 'Team');
    expect(rows[h + 1].slice(6)).toEqual(['a', 'Poor', '1', '']);
    expect(rows[h + 2].slice(6)).toEqual(['b', 'Good', '2', '']);
    expect(rows[h + 3].slice(6)).toEqual(['All Sub-Questions', 'No Response', '', '']);
  });
});
