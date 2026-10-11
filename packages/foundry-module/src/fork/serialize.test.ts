// mcp-fork-9: the rules serialize() applies to every eval-js result, pinned against the
// code as it was in handlers.ts before the move. Frozen: only the import path changes.
import { describe, it, expect } from 'vitest';
import { serialize } from './handlers.js';

describe('serialize', () => {
  it('Set -> array of its values', () => {
    expect(serialize(new Set([1, 2]))).toEqual([1, 2]);
  });

  it('a collection over 100 keeps 100 and says how many more', () => {
    const out = serialize(new Set(Array.from({ length: 150 }, (_, i) => i)));
    expect(out).toHaveLength(101);
    expect(out[100]).toBe('[+50 more]');
  });

  it('Map -> array of its values', () => {
    expect(serialize(new Map([['a', 1]]))).toEqual([1]);
  });

  it('any repeated reference is [circular], not only a true cycle', () => {
    const o = { x: 1 };
    expect(serialize({ a: o, b: o })).toEqual({ a: { x: 1 }, b: '[circular]' });
  });

  it('drops _-keys except _id', () => {
    expect(serialize({ _id: 'i', _hidden: 1, v: 2 })).toEqual({ _id: 'i', v: 2 });
  });

  it('depth over 4 is [max depth]', () => {
    const out = serialize({ l1: { l2: { l3: { l4: { l5: { l6: 1 } } } } } });
    expect(out.l1.l2.l3.l4.l5).toBe('[max depth]');
  });

  it('an array over 200 keeps 200 and says how many more', () => {
    const out = serialize(Array.from({ length: 201 }, (_, i) => i));
    expect(out).toHaveLength(201);
    expect(out[200]).toBe('[+1 more]');
  });

  it('a top-level Document carries its source; a nested one only its identity', () => {
    const doc = { documentName: 'Actor', _id: 'A', name: 'N', toObject: () => ({ k: 1 }) };
    expect(serialize(doc)).toEqual({ _document: 'Actor', _id: 'A', name: 'N', source: { k: 1 } });
    expect(serialize({ d: doc })).toEqual({ d: { _document: 'Actor', _id: 'A', name: 'N' } });
  });

  it('a throwing toObject leaves source undefined', () => {
    const doc = {
      documentName: 'Item',
      _id: 'I',
      name: 'x',
      toObject: () => {
        throw new Error('no');
      },
    };
    expect(serialize(doc)).toEqual({ _document: 'Item', _id: 'I', name: 'x', source: undefined });
  });

  it('errors, functions, bigints, symbols, dates, null and undefined', () => {
    expect(serialize(new Error('e')).error).toBe('e');
    expect(serialize(() => 1)).toMatch(/^\[Function/);
    expect(serialize(10n)).toBe('10');
    expect(serialize(Symbol('s'))).toBe('Symbol(s)');
    expect(serialize(new Date('2026-10-11T00:00:00Z'))).toBe('2026-10-11T00:00:00.000Z');
    expect(serialize(null)).toBeNull();
    expect(serialize(undefined)).toBeNull();
  });

  it('a throwing getter becomes [unserializable]', () => {
    const o = {
      get bad() {
        throw new Error('no');
      },
      ok: 1,
    };
    expect(serialize(o)).toEqual({ bad: '[unserializable]', ok: 1 });
  });

  it('strings are not truncated', () => {
    expect(serialize('x'.repeat(10_000))).toHaveLength(10_000);
  });
});
