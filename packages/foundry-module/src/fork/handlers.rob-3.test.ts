// rob-3: a non-numeric timeoutMs (string, NaN, object) falls back to the 10 s default
// instead of becoming NaN, which setTimeout treats as 0 — an immediate timeout.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerForkHandlers, unregisterForkHandlers } from './handlers.js';

const EVAL = 'foundry-mcp-bridge.fork.eval';

describe('fork eval handler — non-numeric timeoutMs (rob-3)', () => {
  let queries: Record<string, any>;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).game = { user: { isGM: true } };
    (globalThis as any).CONFIG = { queries: {} };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    registerForkHandlers();
    queries = (globalThis as any).CONFIG.queries;
  });
  afterEach(() => {
    unregisterForkHandlers();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const [label, timeoutMs] of [
    ['a non-numeric string', 'soon'],
    ['NaN', Number.NaN],
    ['an object', { ms: 5000 }],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null (as before)', null],
  ] as const) {
    it(`${label} falls back to 10 s`, async () => {
      const p = queries[EVAL]({ script: 'await new Promise(() => {})', timeoutMs });
      let settled = false;
      p.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await p).error).toBe('eval timed out after 10000ms');
    });
  }

  it('a numeric string is used as its number', async () => {
    const p = queries[EVAL]({ script: 'await new Promise(() => {})', timeoutMs: '2000' });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await p).error).toBe('eval timed out after 2000ms');
  });
});
