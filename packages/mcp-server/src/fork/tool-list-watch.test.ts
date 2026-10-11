import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toolsKey, watchToolList } from './tool-list-watch.js';

const A = { name: 'a', description: 'alpha', inputSchema: { type: 'object' } };
const B = { name: 'b', description: 'beta', inputSchema: { type: 'object' } };

describe('toolsKey (mcp-fork-11: the key as it was in index.ts)', () => {
  it('pins the name:description-length key', () => {
    expect(
      toolsKey([
        { name: 'b', description: 'xx' },
        { name: 'a', description: 'y' },
      ])
    ).toBe('a:1|b:2');
    expect(toolsKey([])).toBe('');
    expect(toolsKey(undefined)).toBe('');
  });

  it('is order-independent and changes on a rename', () => {
    expect(toolsKey([A, B])).toBe(toolsKey([B, A]));
    expect(toolsKey([A, B])).not.toBe(toolsKey([A, { ...B, name: 'c' }]));
  });
});

describe('watchToolList', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const tick = () => vi.advanceTimersByTimeAsync(30_000);

  it('notifies once, on the tick where the list changed', async () => {
    const lists = [[A], [A], [A, B]];
    const send = vi.fn(async () => ({ tools: lists.shift() ?? [A, B] }));
    const mcp = { sendToolListChanged: vi.fn(async () => {}) };
    const log = vi.fn();
    const markServed = watchToolList(mcp, send, 30_000, log);
    markServed([A]);
    await tick();
    await tick();
    expect(mcp.sendToolListChanged).not.toHaveBeenCalled();
    await tick();
    expect(mcp.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('tools/list changed; notified the client');
    await tick(); // [A, B] again: no second notification
    expect(mcp.sendToolListChanged).toHaveBeenCalledTimes(1);
  });

  it('does nothing until the session has been served a list', async () => {
    const send = vi.fn(async () => ({ tools: [A] }));
    const mcp = { sendToolListChanged: vi.fn(async () => {}) };
    watchToolList(mcp, send);
    await tick();
    await tick();
    expect(send).not.toHaveBeenCalled();
    expect(mcp.sendToolListChanged).not.toHaveBeenCalled();
  });

  it('swallows a failing poll and tries again next tick', async () => {
    let fail = true;
    const send = vi.fn(async () => {
      if (fail) throw new Error('backend restarting');
      return { tools: [A, B] };
    });
    const mcp = { sendToolListChanged: vi.fn(async () => {}) };
    const markServed = watchToolList(mcp, send);
    markServed([A]);
    await tick();
    expect(mcp.sendToolListChanged).not.toHaveBeenCalled();
    fail = false;
    await tick();
    expect(mcp.sendToolListChanged).toHaveBeenCalledTimes(1);
  });

  it('an empty list from the backend is not a change', async () => {
    const send = vi.fn(async () => ({ tools: [] }));
    const mcp = { sendToolListChanged: vi.fn(async () => {}) };
    const markServed = watchToolList(mcp, send);
    markServed([A]);
    await tick();
    expect(mcp.sendToolListChanged).not.toHaveBeenCalled();
  });

  it('polls at the given interval and does not hold the process open', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    watchToolList({ sendToolListChanged: async () => {} }, async () => ({}));
    expect(spy.mock.calls[0][1]).toBe(30_000);
    const handle: any = spy.mock.results[0].value;
    // fake timers' handles carry hasRef() like Node's
    if (typeof handle?.hasRef === 'function') expect(handle.hasRef()).toBe(false);
    spy.mockRestore();
  });
});
