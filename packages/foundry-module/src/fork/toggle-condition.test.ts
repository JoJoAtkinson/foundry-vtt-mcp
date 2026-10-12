import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerForkHandlers, unregisterForkHandlers } from './handlers.js';
import { withToggleDefault } from './toggle-condition.js';

/**
 * toggle-token-condition's schema says `active` is optional ("omitted = toggle the current
 * state"), but upstream's handler rejects a missing `active` with "active must be a boolean".
 * The fork's wrapper resolves an omitted `active` from the token's current effects.
 */
function scene(effects: any[]) {
  const actor = { effects: { contents: effects } };
  const token = { id: 'T1', name: 'Talo', actor };
  return { tokens: { get: (id: string) => (id === 'T1' ? token : undefined) } };
}

function install(effects: any[]) {
  (globalThis as any).game = { user: { isGM: true }, scenes: { current: scene(effects) } };
  (globalThis as any).CONFIG = {
    statusEffects: [{ id: 'prone', name: 'Prone' }],
    queries: {
      'foundry-mcp-bridge.toggle-token-condition': vi.fn(async (d: any) => {
        if (typeof d.active !== 'boolean') throw new Error('active must be a boolean');
        return { isActive: d.active };
      }),
    },
  };
  (globalThis as any).CONFIG.queries['foundry-mcp-bridge.toggleTokenCondition'] = (
    globalThis as any
  ).CONFIG.queries['foundry-mcp-bridge.toggle-token-condition'];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  registerForkHandlers();
  return (globalThis as any).CONFIG.queries as Record<string, any>;
}

describe('toggle-token-condition with active omitted', () => {
  afterEach(() => {
    unregisterForkHandlers();
    vi.restoreAllMocks();
  });

  it('applies the condition when the token does not have it', async () => {
    const q = install([]);
    const res = await q['foundry-mcp-bridge.toggle-token-condition']({
      tokenId: 'T1',
      conditionId: 'prone',
    });
    expect(res).toEqual({ isActive: true });
  });

  it('removes the condition when the token has it (by status)', async () => {
    const q = install([{ statuses: new Set(['prone']), name: 'Prone' }]);
    const res = await q['foundry-mcp-bridge.toggleTokenCondition']({
      tokenId: 'T1',
      conditionId: 'prone',
    });
    expect(res).toEqual({ isActive: false });
  });

  it('matches by name, case-insensitively, as upstream removal does', async () => {
    const q = install([{ statuses: new Set(), name: 'Prone' }]);
    const res = await q['foundry-mcp-bridge.toggle-token-condition']({
      tokenId: 'T1',
      conditionId: 'PRONE',
    });
    expect(res).toEqual({ isActive: false });
  });

  it('fork-edge-4: a name that matches only via the resolved status id applies, never a no-op removal', async () => {
    // 'Prone' resolves to status id 'prone', but upstream's removal checks the raw string
    // ('Prone') against statuses/name/label — none match this effect, so active:false would
    // remove nothing. Default to active:true, which upstream can carry out.
    const q = install([{ statuses: new Set(['prone']), name: 'Liegend' }]);
    const res = await q['foundry-mcp-bridge.toggle-token-condition']({
      tokenId: 'T1',
      conditionId: 'Prone',
    });
    expect(res).toEqual({ isActive: true });
  });

  it('matches by label, case-insensitively, as upstream removal does', async () => {
    const q = install([{ statuses: new Set(), label: 'Prone' }]);
    const res = await q['foundry-mcp-bridge.toggle-token-condition']({
      tokenId: 'T1',
      conditionId: 'prone',
    });
    expect(res).toEqual({ isActive: false });
  });

  it('an explicit active is passed through untouched', async () => {
    const q = install([{ statuses: new Set(['prone']) }]);
    const res = await q['foundry-mcp-bridge.toggle-token-condition']({
      tokenId: 'T1',
      conditionId: 'prone',
      active: true,
    });
    expect(res).toEqual({ isActive: true });
  });
});

describe('withToggleDefault', () => {
  beforeEach(() => {
    (globalThis as any).game = { scenes: { current: scene([]) } };
    (globalThis as any).CONFIG = { statusEffects: [] };
  });

  it('an unknown token defaults to active:true so upstream reports its own not-found error', () => {
    expect(withToggleDefault({ tokenId: 'nope', conditionId: 'prone' })).toEqual({
      tokenId: 'nope',
      conditionId: 'prone',
      active: true,
    });
  });

  it('never throws on junk input', () => {
    expect(() => withToggleDefault(undefined as any)).not.toThrow();
    expect(() => withToggleDefault({ tokenId: 'T1' } as any)).not.toThrow();
  });
});
