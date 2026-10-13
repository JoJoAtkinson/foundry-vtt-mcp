// rob-2: an invalid Date (getTime() is NaN) is '[unserializable]' wherever it appears,
// instead of toISOString() throwing RangeError and failing the whole eval.
import { describe, it, expect } from 'vitest';
import { serialize } from './serialize.js';

const bad = () => new Date('not a date');

describe('serialize — invalid Date (rob-2)', () => {
  it('at top level', () => {
    expect(serialize(bad())).toBe('[unserializable]');
  });

  it('as an array element', () => {
    expect(serialize([1, bad(), 2])).toEqual([1, '[unserializable]', 2]);
  });

  it('as a collection value', () => {
    expect(serialize(new Map([['a', bad()]]))).toEqual(['[unserializable]']);
    expect(serialize(new Set([bad()]))).toEqual(['[unserializable]']);
  });

  it('as an object property', () => {
    expect(serialize({ when: bad(), ok: 1 })).toEqual({ when: '[unserializable]', ok: 1 });
  });

  it('a valid Date is still its ISO string', () => {
    expect(serialize([new Date('2026-10-12T00:00:00Z')])).toEqual(['2026-10-12T00:00:00.000Z']);
  });
});
