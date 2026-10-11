import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerForkHandlers, unregisterForkHandlers } from './handlers.js';

const EVAL = 'foundry-mcp-bridge.fork.eval';

function install() {
  (globalThis as any).game = { user: { isGM: true } };
  (globalThis as any).CONFIG = { queries: {} };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  registerForkHandlers();
  return (globalThis as any).CONFIG.queries as Record<string, any>;
}

describe('fork eval handler', () => {
  let queries: Record<string, any>;
  beforeEach(() => {
    vi.useFakeTimers();
    queries = install();
  });
  afterEach(() => {
    unregisterForkHandlers();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a completed script leaves no timer behind (mcp-fork-8)', async () => {
    const res = await queries[EVAL]({ script: 'return 1' });
    expect(res).toMatchObject({ ok: true, phase: 'complete', resultType: 'number', result: 1 });
    // Before mcp-fork-8 the race's timer stayed pending (count 1) for up to 60 s.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a hung script times out at timeoutMs', async () => {
    const p = queries[EVAL]({ script: 'await new Promise(() => {})', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res).toMatchObject({
      ok: false,
      phase: 'runtime',
      error: 'eval timed out after 1000ms',
      // new with mcp-fork-8: a timeout is told apart from a script that threw
      timedOut: true,
      note: 'the script may still be running; re-read state before retrying',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a throwing script is a runtime failure without timedOut', async () => {
    const res = await queries[EVAL]({ script: 'throw new Error("x")' });
    expect(res).toMatchObject({ ok: false, phase: 'runtime', error: 'x' });
    expect(res.timedOut).toBeUndefined();
  });

  it('a syntax error is a compile failure', async () => {
    const res = await queries[EVAL]({ script: 'return (' });
    expect(res).toMatchObject({ ok: false, phase: 'compile' });
  });

  it('timeoutMs is clamped to 1-60 s', async () => {
    const p = queries[EVAL]({ script: 'await new Promise(() => {})', timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).error).toBe('eval timed out after 1000ms');
  });
});

describe('GM guard on bridge queries (mcp-fork-2)', () => {
  let x: any;
  let fnP: any;
  beforeEach(() => {
    (globalThis as any).game = { user: { isGM: true } };
    x = vi.fn(async (d: any) => ({ echo: d }));
    fnP = vi.fn(async () => 'prompts');
    (globalThis as any).CONFIG = {
      queries: { 'foundry-mcp-bridge.x': x, 'pentaryn-prompts.list': fnP },
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    unregisterForkHandlers();
    vi.restoreAllMocks();
  });
  const q = () => (globalThis as any).CONFIG.queries;

  it('the fork eval refuses a non-GM sender and serves the bridge socket (no ctx)', async () => {
    registerForkHandlers();
    await expect(q()[EVAL]({ script: 'return 1' }, { user: { isGM: false } })).rejects.toThrow(
      /may only be queried by a GM/
    );
    // mcp-fork-24: coded like the kit's errors
    await expect(
      q()[EVAL]({ script: 'return 1' }, { user: { isGM: false } })
    ).rejects.toMatchObject({
      code: 'NOT_GM',
      message: 'NOT_GM: Access denied: fork tools may only be queried by a GM.',
    });
    await expect(q()[EVAL]({ script: 'return 1' })).resolves.toMatchObject({ ok: true, result: 1 });
  });

  it('a non-GM tab refuses eval outright', async () => {
    registerForkHandlers();
    (globalThis as any).game.user.isGM = false;
    await expect(q()[EVAL]({ script: 'return 1' })).rejects.toThrow(/require a GM session/);
    await expect(q()[EVAL]({ script: 'return 1' })).rejects.toMatchObject({
      code: 'NOT_GM',
      message: expect.stringMatching(/^NOT_GM: /),
    });
  });

  it('upstream bridge queries: no ctx and GM senders pass', async () => {
    registerForkHandlers();
    await expect(q()['foundry-mcp-bridge.x']({ a: 1 })).resolves.toEqual({ echo: { a: 1 } });
    await expect(q()['foundry-mcp-bridge.x']({ a: 1 }, { user: { isGM: true } })).resolves.toEqual({
      echo: { a: 1 },
    });
  });

  it('upstream bridge queries from a player', async () => {
    registerForkHandlers();
    // Before mcp-fork-2 this resolved {echo:{a:1}}: a player's User#query ran it as the GM.
    await expect(q()['foundry-mcp-bridge.x']({ a: 1 }, { user: { isGM: false } })).rejects.toThrow(
      /Access denied/
    );
    await expect(
      q()['foundry-mcp-bridge.x']({ a: 1 }, { user: { isGM: false } })
    ).rejects.toMatchObject({ code: 'NOT_GM', message: expect.stringMatching(/^NOT_GM: /) });
    expect(x).not.toHaveBeenCalled();
  });

  it('registering twice does not double-wrap', async () => {
    registerForkHandlers();
    const once = q()['foundry-mcp-bridge.x'];
    registerForkHandlers();
    expect(q()['foundry-mcp-bridge.x']).toBe(once);
    await q()['foundry-mcp-bridge.x']({ a: 1 });
    expect(x).toHaveBeenCalledTimes(1);
  });

  it('the wrapper passes data and ctx through unchanged', async () => {
    registerForkHandlers();
    const ctx = { user: { isGM: true }, timeout: 5 };
    await q()['foundry-mcp-bridge.x']({ a: 1 }, ctx);
    expect(x).toHaveBeenCalledWith({ a: 1 }, ctx);
  });

  it("other modules' queries are left alone", () => {
    registerForkHandlers();
    expect(q()['pentaryn-prompts.list']).toBe(fnP);
  });
});
