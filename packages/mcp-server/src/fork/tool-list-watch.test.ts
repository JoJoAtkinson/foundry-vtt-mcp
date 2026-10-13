import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toolsKey, watchToolList } from './tool-list-watch.js';

const A = { name: 'a', description: 'alpha', inputSchema: { type: 'object' } };
const B = { name: 'b', description: 'beta', inputSchema: { type: 'object' } };

describe('toolsKey', () => {
  it('is a sha1 of the sorted [name, description, inputSchema] triples (mcp-fork-12)', () => {
    // Before mcp-fork-12 the key was name:description-length ('a:1|b:2', '' for none).
    const key = toolsKey([
      { name: 'b', description: 'xx' },
      { name: 'a', description: 'y' },
    ]);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
    expect(toolsKey([])).toBe(toolsKey(undefined));
    expect(toolsKey([])).not.toBe(key);
  });

  it('changes when an inputSchema gains a property', () => {
    const wider = {
      ...A,
      inputSchema: { type: 'object', properties: { specFile: { type: 'string' } } },
    };
    expect(toolsKey([A, B])).not.toBe(toolsKey([wider, B]));
  });

  it('changes on a same-length description edit', () => {
    expect(toolsKey([A])).not.toBe(toolsKey([{ ...A, description: 'ALPHA' }]));
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

  it('a failed tools/list_changed send is logged and retried next tick (rob-6)', async () => {
    // Before rob-6 the list was marked served before the send, and the catch was empty:
    // one failed notify meant the session never heard of the change.
    const send = vi.fn(async () => ({ tools: [A, B] }));
    let fail = true;
    const mcp = {
      sendToolListChanged: vi.fn(async () => {
        if (fail) throw new Error('transport closed');
      }),
    };
    const log = vi.fn();
    const markServed = watchToolList(mcp, send, 30_000, log);
    markServed([A]);
    await tick();
    expect(mcp.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'tools/list changed but notify failed: transport closed; will retry'
    );
    fail = false;
    await tick();
    expect(mcp.sendToolListChanged).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('tools/list changed; notified the client');
    await tick(); // now served: no third notification
    expect(mcp.sendToolListChanged).toHaveBeenCalledTimes(2);
  });

  it('skips a tick while the previous poll is still in flight (fork-edge-7)', async () => {
    // Before fork-edge-7 every tick started a poll even when the last one had not
    // finished, so a slow notify let two polls both see the change and both send it.
    const send = vi.fn(async () => ({ tools: [A, B] }));
    let release!: () => void;
    const mcp = {
      sendToolListChanged: vi.fn(
        () => new Promise<void>(resolve => (release = resolve))
      ),
    };
    const markServed = watchToolList(mcp, send);
    markServed([A]);
    await tick(); // first poll: notify hangs
    expect(mcp.sendToolListChanged).toHaveBeenCalledTimes(1);
    await tick(); // still in flight: this tick is skipped
    expect(send).toHaveBeenCalledTimes(1);
    expect(mcp.sendToolListChanged).toHaveBeenCalledTimes(1);
    release();
    await tick(); // first poll finished and marked served: no duplicate
    expect(mcp.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a failed backend poll stays silent', async () => {
    const send = vi.fn(async () => {
      throw new Error('backend restarting');
    });
    const log = vi.fn();
    const markServed = watchToolList({ sendToolListChanged: vi.fn(async () => {}) }, send, 30_000, log);
    markServed([A]);
    await tick();
    expect(log).not.toHaveBeenCalled();
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
