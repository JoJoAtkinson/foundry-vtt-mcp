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
