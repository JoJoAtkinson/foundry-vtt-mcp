// Harness smoke test: the fork's browser-side handlers load under node with stubbed
// Foundry globals and register into CONFIG.queries.
import { beforeEach, describe, expect, it } from 'vitest';

describe('foundry-module vitest harness', () => {
  beforeEach(() => {
    (globalThis as any).game = { user: { isGM: true } };
    (globalThis as any).CONFIG = { queries: {} };
  });

  it('imports fork/handlers and registers the eval query', async () => {
    const { registerForkHandlers, unregisterForkHandlers } = await import('./handlers.js');
    registerForkHandlers();
    expect(typeof (globalThis as any).CONFIG.queries['foundry-mcp-bridge.fork.eval']).toBe(
      'function'
    );
    unregisterForkHandlers();
    expect((globalThis as any).CONFIG.queries['foundry-mcp-bridge.fork.eval']).toBeUndefined();
  });

  it('register adds exactly the fork queries and unregister removes them', async () => {
    const { registerForkHandlers, unregisterForkHandlers } = await import('./handlers.js');
    const forkKeys = () =>
      Object.keys((globalThis as any).CONFIG.queries).filter(k =>
        k.startsWith('foundry-mcp-bridge.fork.')
      );
    registerForkHandlers();
    expect(forkKeys()).toEqual([
      'foundry-mcp-bridge.fork.eval',
      'foundry-mcp-bridge.fork.applyRecharge',
    ]);
    unregisterForkHandlers();
    expect(forkKeys()).toEqual([]);
  });
});
