// rob-4: only an omitted `active` is filled in. A non-boolean `active` (string, null, number)
// passes through unchanged, so upstream's own "active must be a boolean" refuses it instead
// of the wrapper silently overwriting it with a toggle.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerForkHandlers, unregisterForkHandlers } from './handlers.js';
import { withToggleDefault } from './toggle-condition.js';

const KEY = 'foundry-mcp-bridge.toggle-token-condition';

function install() {
  const actor = { effects: { contents: [{ statuses: new Set(['prone']), name: 'Prone' }] } };
  const token = { id: 'T1', name: 'Talo', actor };
  (globalThis as any).game = {
    user: { isGM: true },
    scenes: { current: { tokens: { get: (id: string) => (id === 'T1' ? token : undefined) } } },
  };
  (globalThis as any).CONFIG = {
    statusEffects: [{ id: 'prone', name: 'Prone' }],
    queries: {
      [KEY]: vi.fn(async (d: any) => {
        if (typeof d.active !== 'boolean') throw new Error('active must be a boolean');
        return { isActive: d.active };
      }),
    },
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  registerForkHandlers();
  return (globalThis as any).CONFIG.queries as Record<string, any>;
}

describe('toggle-token-condition — non-boolean active is refused, not overwritten (rob-4)', () => {
  afterEach(() => {
    unregisterForkHandlers();
    vi.restoreAllMocks();
  });

  for (const bad of ['true', 'false', null, 1, 0]) {
    it(`active: ${JSON.stringify(bad)} reaches upstream unchanged and is refused`, async () => {
      const q = install();
      await expect(q[KEY]({ tokenId: 'T1', conditionId: 'prone', active: bad })).rejects.toThrow(
        'active must be a boolean'
      );
      expect(withToggleDefault({ tokenId: 'T1', conditionId: 'prone', active: bad })).toEqual({
        tokenId: 'T1',
        conditionId: 'prone',
        active: bad,
      });
    });
  }

  it('an omitted active (absent or undefined) is still filled in', async () => {
    const q = install();
    await expect(q[KEY]({ tokenId: 'T1', conditionId: 'prone' })).resolves.toEqual({
      isActive: false,
    });
    await expect(
      q[KEY]({ tokenId: 'T1', conditionId: 'prone', active: undefined })
    ).resolves.toEqual({ isActive: false });
  });
});
