import { describe, expect, it } from 'vitest';
import { alphabeticalIndex, answerText, contribValueText, numberText } from './answerText';

describe('contribValueText (spec section b)', () => {
  it('uses Equal share wording', () => {
    expect(contribValueText(110)).toBe('Equal share + 10%');
    expect(contribValueText(200)).toBe('Equal share + 100%');
    expect(contribValueText(101)).toBe('Equal share + 1%');
    expect(contribValueText(100)).toBe('Equal share');
    expect(contribValueText(95)).toBe('Equal share - 5%');
    expect(contribValueText(1)).toBe('Equal share - 99%');
    expect(contribValueText(0)).toBe('0%');
    expect(contribValueText(-101)).toBe('Not Sure');
    expect(contribValueText(-5)).toBe('');
  });
});

describe('helpers', () => {
  it('numberText rounds to three decimals without trailing zeros', () => {
    expect(numberText(2.5)).toBe('2.5');
    expect(numberText(3)).toBe('3');
    expect(numberText(0.12345)).toBe('0.123');
    expect(numberText(0.1 + 0.2)).toBe('0.3');
  });
  it('alphabeticalIndex counts a, b, ... z, aa', () => {
    expect([1, 2, 26, 27, 28].map(alphabeticalIndex)).toEqual(['a', 'b', 'z', 'aa', 'ba']);
  });
});

describe('answerText per type', () => {
  it('text', () => expect(answerText({ type: 'text', details: {} }, { text: 'hello' })).toBe('hello'));
  it('mcq', () => {
    const q = { type: 'mcq' as const, details: { choices: ['a', 'b'], otherEnabled: true } };
    expect(answerText(q, { choice: 'b' })).toBe('b');
    expect(answerText(q, { other: 'zzz' })).toBe('zzz');
  });
  it('msq', () => {
    const q = { type: 'msq' as const, details: { choices: ['a', 'b', 'c'], otherEnabled: true } };
    expect(answerText(q, { choices: ['a', 'c'] })).toBe('a, c');
    expect(answerText(q, { choices: ['a'], other: 'x' })).toBe('a, x');
    expect(answerText(q, { choices: [] })).toBe('None of the above');
  });
  it('numscale', () => expect(answerText({ type: 'numscale', details: {} }, { value: 3.5 })).toBe('3.5'));
  it('constsum_options', () => {
    expect(answerText({ type: 'constsum_options', details: { options: ['x', 'y'] } }, { points: [70, 30] })).toBe('x: 70, y: 30');
  });
  it('constsum_recipients', () => expect(answerText({ type: 'constsum_recipients', details: {} }, { points: 110 })).toBe('110'));
  it('contrib', () => {
    expect(answerText({ type: 'contrib', details: {} }, { value: 120 })).toBe('Equal share + 20%');
    expect(answerText({ type: 'contrib', details: {} }, { value: 90 })).toBe('Equal share - 10%');
  });
  it('rubric', () => {
    const q = { type: 'rubric' as const, details: { choices: ['Poor', 'Good'], subQuestions: ['Effort', 'Quality'], descriptions: [] } };
    expect(answerText(q, { choices: [1, -1] })).toBe('a) Effort: Good; b) Quality: No Response');
  });
  it('rank_options', () => {
    const q = { type: 'rank_options' as const, details: { options: ['x', 'y', 'z'] } };
    expect(answerText(q, { ranks: [2, null, 1] })).toBe('x: 2, z: 1');
  });
  it('rank_recipients', () => expect(answerText({ type: 'rank_recipients', details: {} }, { rank: 2 })).toBe('2'));
  it('malformed answers give an empty string', () => {
    for (const type of ['text', 'mcq', 'msq', 'numscale', 'constsum_options', 'constsum_recipients', 'contrib', 'rubric', 'rank_options', 'rank_recipients'] as const) {
      expect(answerText({ type, details: {} }, null), type).toBe('');
      expect(answerText({ type, details: {} }, 'x'), type).toBe('');
      expect(answerText({ type, details: {} }, {}), type).toBe(type === 'msq' ? '' : '');
    }
  });
});
