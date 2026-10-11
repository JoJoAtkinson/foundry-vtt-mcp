/**
 * The D14 call template, executed — not mocked. The fake client hands fork.eval to the
 * bridge module's real handler (packages/foundry-module/src/fork/handlers.ts: GM guard,
 * "use strict" async wrapper, timeout race, serialize()), with game.pentaryn stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unregisterForkHandlers } from '../../../../foundry-module/src/fork/handlers.js';
import { buildCallScript, runPentarynCall, type PentarynCall } from './pentaryn-call.js';
import {
  calls,
  evalClient,
  fakeNamespace,
  installGame,
  useFakeEvalTimers,
} from './pentaryn-call.test.fixtures.js';

const run = (call: Omit<PentarynCall, 'mode'> & { mode?: 'read' | 'write' }) =>
  runPentarynCall(evalClient(), { mode: 'read', ...call } as PentarynCall, 10_000);

describe('pentaryn-call template', () => {
  useFakeEvalTimers();
  beforeEach(() => {
    calls.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    installGame();
  });
  afterEach(() => {
    unregisterForkHandlers();
    vi.restoreAllMocks();
    delete (globalThis as any).game;
  });

  it('read of a read row calls it with (ref, opts) and returns the result', async () => {
    const env = await run({ ns: 'fake', path: 'store.list', ref: 'Esren' });
    expect(env).toEqual({ ok: true, ns: 'fake', path: 'store.list', result: { rows: ['Esren'] } });
    expect(calls).toEqual([['list', 'Esren', undefined]]);
  });

  it('read of a write row is refused before anything runs', async () => {
    const env = await run({ ns: 'fake', path: 'store.set', ref: 'Esren' });
    expect(env).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(env.reason).toMatch(/fake\.store\.set is a write row; use pentaryn-write/);
    expect(calls).toEqual([]);
  });

  it('write of a read row is refused', async () => {
    const env = await run({ mode: 'write', ns: 'fake', path: 'store.list', ref: 'Esren' });
    expect(env).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(env.reason).toMatch(/is a read row; use pentaryn-read/);
    expect(calls).toEqual([]);
  });

  it('write with dryRun merges it into opts and copies the module answer', async () => {
    const env = await run({
      mode: 'write',
      ns: 'fake',
      path: 'store.set',
      ref: 'Esren',
      opts: { value: 3 },
      dryRun: true,
    });
    expect(calls).toEqual([['set', 'Esren', { value: 3, dryRun: true }]]);
    expect(env).toEqual({
      ok: true,
      ns: 'fake',
      path: 'store.set',
      result: { ok: true, dryRun: true, ids: [] },
    });
  });

  it("a write row's own fail() is returned as a value with its code copied up", async () => {
    const env = await run({ mode: 'write', ns: 'fake', path: 'refuse' });
    expect(env).toEqual({
      ok: false,
      ns: 'fake',
      path: 'refuse',
      code: 'CONFLICT',
      reason: 'already running',
      result: { ok: false, code: 'CONFLICT', reason: 'already running' },
    });
  });

  it('ref is passed through verbatim; the module answers NOT_FOUND, not the fork', async () => {
    const env = await run({ ns: 'fake', path: 'store.list', ref: 'Ald' });
    expect(calls).toEqual([['list', 'Ald', undefined]]);
    expect(env).toEqual({
      ok: false,
      ns: 'fake',
      path: 'store.list',
      code: 'NOT_FOUND',
      reason: 'NOT_FOUND: actor Ald',
    });
  });

  it('a coded error without a code property is read from its message prefix', async () => {
    const env = await run({ ns: 'fake', path: 'store.list', ref: 'Esr' });
    expect(env).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
  });

  it('an uncoded throw is INTERNAL with the message', async () => {
    expect(await run({ ns: 'fake', path: 'boom' })).toMatchObject({
      ok: false,
      code: 'INTERNAL',
      reason: 'x.slice is not a function',
    });
  });

  it('unknown path -> NOT_FOUND listing the paths and which are writes', async () => {
    const env = await run({ ns: 'fake', path: 'nope' });
    expect(env.code).toBe('NOT_FOUND');
    expect(env.paths).toEqual([
      'store.list',
      'store.set',
      'search',
      'deep',
      'actor',
      'boom',
      'refuse',
      'describe',
      'inspect',
    ]);
    expect(env.writes).toMatchObject({ 'store.list': false, 'store.set': true, inspect: false });
  });

  it('selftest is listed when the namespace has one', async () => {
    unregisterForkHandlers();
    const ns = fakeNamespace();
    ns.selftest = async () => ({ ok: true, checks: [] });
    installGame(ns);
    const env = await run({ ns: 'fake', path: 'nope' });
    expect(env.paths).toContain('selftest');
    expect(await run({ ns: 'fake', path: 'selftest' })).toMatchObject({
      ok: true,
      result: { ok: true, checks: [] },
    });
  });

  it('unknown namespace -> NOT_FOUND with the namespace list', async () => {
    const env = await run({ ns: 'ties', path: 'attributes.of' });
    expect(env).toMatchObject({ ok: false, code: 'NOT_FOUND', namespaces: ['fake'] });
    expect(env.reason).toMatch(/eval-js only/);
  });

  it('no game.pentaryn at all -> NOT_FOUND saying so', async () => {
    delete (globalThis as any).game.pentaryn;
    expect(await run({ ns: 'fake', path: 'store.list' })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
      reason: 'game.pentaryn is not installed (no blueprint module is active)',
    });
  });

  it('{ns:"*", path:"describe"} is the root describe, whole (deeper than serialize allows)', async () => {
    const env = await run({ ns: '*', path: 'describe' });
    expect(env.ok).toBe(true);
    const fake = (env.result as any).namespaces.fake;
    // methods -> row -> params -> param is depth 5+ from the envelope: still plain data
    expect(fake.methods[1].params[1]).toEqual({ name: 'opts' });
    expect((env.result as any).modules).toEqual(['pentaryn-fake']);
  });

  it('{ns:"*", path:"inspect"} reads; the root refuses writes and unknown paths', async () => {
    expect(await run({ ns: '*', path: 'inspect', ref: 'Esren' })).toMatchObject({
      ok: true,
      result: { fake: { ref: 'Esren' } },
    });
    expect(await run({ mode: 'write', ns: '*', path: 'describe' })).toMatchObject({
      ok: false,
      code: 'BAD_ARGS',
    });
    expect(await run({ ns: '*', path: 'x' })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
      paths: ['describe', 'inspect'],
      namespaces: ['fake'],
    });
  });

  it('inspect with a ref works on read and is BAD_ARGS on write', async () => {
    expect(await run({ ns: 'fake', path: 'inspect', ref: 'Esren' })).toMatchObject({
      ok: true,
      result: { ref: 'Esren', opts: {}, depth: 1 },
    });
    expect(await run({ mode: 'write', ns: 'fake', path: 'inspect', ref: 'Esren' })).toMatchObject({
      ok: false,
      code: 'BAD_ARGS',
    });
  });

  it('describe on a namespace returns its manifest', async () => {
    const env = await run({ ns: 'fake', path: 'describe' });
    expect((env.result as any).methods).toHaveLength(7);
  });

  it('positional params come from opts by name; the opts param gets the rest', async () => {
    const env = await run({ ns: 'fake', path: 'search', opts: { query: 'grapple', limit: 3 } });
    expect(calls).toEqual([['search', 'grapple', { limit: 3 }]]);
    expect(env.result).toEqual({ results: ['grapple'], opts: { limit: 3 } });
  });

  it('opts a row cannot take, and a ref on a row without one, are BAD_ARGS', async () => {
    expect(await run({ ns: 'fake', path: 'store.list', ref: 'E', opts: { x: 1 } })).toMatchObject({
      ok: false,
      code: 'BAD_ARGS',
      reason: expect.stringMatching(/not a parameter: x/),
    });
    expect(await run({ ns: 'fake', path: 'deep', ref: 'E' })).toMatchObject({
      ok: false,
      code: 'BAD_ARGS',
      reason: expect.stringMatching(/takes no ref/),
    });
    expect(calls).toEqual([]);
  });

  it('Documents come back as refs, not sources', async () => {
    expect((await run({ ns: 'fake', path: 'actor' })).result).toEqual({
      _document: 'Actor',
      _id: 'A1',
      name: 'Esren',
      uuid: 'Actor.A1',
    });
  });

  it('nesting survives past the eval serializer depth', async () => {
    expect((await run({ ns: 'fake', path: 'deep' })).result).toEqual({
      a: { b: { c: { d: { e: { f: { g: 1 } } } } } },
    });
  });

  it('the script is the fixed template plus one JSON literal (no code from caller strings)', () => {
    const evil = "'); game.users.contents.forEach(u => u.delete()); ('";
    const a = buildCallScript({ mode: 'read', ns: 'fake', path: 'store.list', ref: evil });
    const b = buildCallScript({ mode: 'read', ns: 'fake', path: 'store.list', ref: 'x' });
    const lit = (s: string) => /^const call = (.*);$/m.exec(s)![1];
    expect(JSON.parse(lit(a)).ref).toBe(evil);
    expect(a.replace(lit(a), '')).toBe(b.replace(lit(b), ''));
    // `$&`-style replacement patterns in a value are not interpreted
    const c = buildCallScript({ mode: 'read', ns: 'fake', path: 'p', ref: "$& $' $`" });
    expect(JSON.parse(lit(c)).ref).toBe("$& $' $`");
  });

  it('the eval timeout runs on the fake clock and is cleared when the call answers', async () => {
    const armed = vi.spyOn(globalThis, 'setTimeout');
    await run({ ns: 'fake', path: 'deep' });
    expect(armed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('timeoutMs reaches the eval as given and the transport as +2000', async () => {
    const client = evalClient();
    await runPentarynCall(client, { mode: 'read', ns: 'fake', path: 'deep' }, 4000);
    expect(client.sent[0].data.timeoutMs).toBe(4000);
    expect(client.sent[0].opts).toEqual({ timeoutMs: 6000 });
  });
});

describe('transport failures throw coded errors', () => {
  const call: PentarynCall = { mode: 'read', ns: 'fake', path: 'deep' };
  const failing = (err: Error | object) => ({
    query: async () => {
      if (err instanceof Error) throw err;
      return err;
    },
  });

  it('bridge not connected -> MODULE_MISSING', async () => {
    await expect(
      runPentarynCall(
        failing(new Error('Foundry VTT module not connected. Please ensure Foundry is running')),
        call,
        1000
      )
    ).rejects.toMatchObject({ code: 'MODULE_MISSING' });
    await expect(
      runPentarynCall(
        failing(
          new Error(
            'Query foundry-mcp-bridge.fork.eval failed: No handler found for query: foundry-mcp-bridge.fork.eval'
          )
        ),
        call,
        1000
      )
    ).rejects.toThrow(/^MODULE_MISSING: foundry-mcp-bridge is not connected/);
  });

  it('connector timeout -> TIMEOUT naming the call', async () => {
    await expect(
      runPentarynCall(
        failing(new Error('Query timeout: foundry-mcp-bridge.fork.eval (3000 ms)')),
        call,
        1000
      )
    ).rejects.toThrow(/^TIMEOUT: fake\.deep did not answer in 3000 ms/);
  });

  it('browser-side timeout -> TIMEOUT', async () => {
    await expect(
      runPentarynCall(
        failing({
          ok: false,
          phase: 'runtime',
          error: 'eval timed out after 1000ms',
          timedOut: true,
        }),
        call,
        1000
      )
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('the template itself failing -> INTERNAL', async () => {
    await expect(
      runPentarynCall(
        failing({ ok: false, phase: 'compile', error: 'Unexpected token' }),
        call,
        1000
      )
    ).rejects.toThrow(/^INTERNAL: fake\.deep: the call script failed at compile/);
    await expect(
      runPentarynCall(failing({ ok: true, phase: 'complete', result: 1 }), call, 1000)
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
