/**
 * Shared by the pentaryn-call/-read/-write tests (not a test file itself: tsc and vitest both
 * skip it by name). A fake game.pentaryn namespace and a FoundryClient whose fork.eval is
 * the bridge module's real handler, so the call template is executed, not mocked.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { registerForkHandlers } from '../../../../foundry-module/src/fork/handlers.js';

export const calls: any[] = [];

/** One read row and one write row (plan §3.6), plus positional and kit members. */
export function fakeNamespace() {
  const ns: any = {
    contract: 'pentaryn-fake/api@1',
    describe: () => ({
      module: 'pentaryn-fake',
      namespace: 'fake',
      methods: [
        {
          path: 'store.list',
          params: [{ name: 'ref', kind: 'actor' }],
          gm: false,
          writes: false,
          doc: 'list',
        },
        {
          path: 'store.set',
          params: [{ name: 'ref', kind: 'actor' }, { name: 'opts' }],
          gm: true,
          writes: true,
          doc: 'set',
        },
        {
          path: 'search',
          params: [
            { name: 'query', type: 'string' },
            { name: 'opts', optional: true },
          ],
          gm: false,
          writes: false,
          doc: 'positional',
        },
        { path: 'deep', params: [], gm: false, writes: false, doc: 'nested result' },
        { path: 'actor', params: [], gm: false, writes: false, doc: 'returns a Document' },
        { path: 'boom', params: [], gm: false, writes: false, doc: 'throws untyped' },
        { path: 'refuse', params: [{ name: 'opts' }], gm: true, writes: true, doc: 'fail()' },
      ],
    }),
    inspect: async (ref: string, opts: any) => ({ ref, opts, depth: 1 }),
    store: {
      list: async (ref: string, opts: any) => {
        calls.push(['list', ref, opts]);
        if (ref === 'Ald')
          throw Object.assign(new Error('NOT_FOUND: actor Ald'), { code: 'NOT_FOUND' });
        if (ref === 'Esr') throw new Error('AMBIGUOUS: 2 actors named like Esr');
        return { rows: [ref] };
      },
      set: async (ref: string, opts: any) => {
        calls.push(['set', ref, opts]);
        return opts?.dryRun ? { ok: true, dryRun: true, ids: [] } : { ok: true, ids: ['i1'] };
      },
    },
    search: async (query: string, opts: any) => {
      calls.push(['search', query, opts]);
      return { results: [query], opts };
    },
    deep: async () => ({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }),
    actor: async () => ({
      documentName: 'Actor',
      _id: 'A1',
      name: 'Esren',
      uuid: 'Actor.A1',
      toObject: () => ({ huge: true }),
    }),
    boom: async () => {
      throw new TypeError('x.slice is not a function');
    },
    refuse: async () => ({ ok: false, code: 'CONFLICT', reason: 'already running' }),
  };
  return ns;
}

export function installGame(ns = fakeNamespace()) {
  const pentaryn: any = {
    fake: ns,
    namespaces: () => ['fake'],
    describe: () => ({ modules: ['pentaryn-fake'], namespaces: { fake: ns.describe() } }),
    inspect: async (ref: string) => ({ fake: { ref } }),
  };
  (globalThis as any).game = { user: { isGM: true }, pentaryn };
  (globalThis as any).CONFIG = { queries: {} };
  registerForkHandlers();
  return pentaryn;
}

/**
 * No real timers (blueprint test rule): the real fork.eval handler arms its timeout with
 * setTimeout, so every suite that runs it calls this once at its top level.
 */
export function useFakeEvalTimers() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

/**
 * A FoundryClient whose fork.eval is the bridge module's real handler. Under fake timers
 * each answered call must leave no timer behind (the handler clears its timeout).
 */
export function evalClient() {
  const sent: any[] = [];
  const query = vi.fn(async (method: string, data: any, opts?: any) => {
    sent.push({ method, data, opts });
    const h = (globalThis as any).CONFIG.queries[method];
    if (!h) throw new Error(`No handler found for query: ${method}`);
    const r = await h(data);
    if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0);
    return r;
  });
  return { query, sent };
}
