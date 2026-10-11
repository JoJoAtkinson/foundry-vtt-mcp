import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { rechargeUpdate } from './recharge.js';
import { registerForkHandlers, unregisterForkHandlers } from './handlers.js';

/** The audit's fixture item: one activity with an itemUses and a material target. */
function fixtureItem() {
  return {
    id: 'I1',
    name: 'Breath',
    system: {
      activities: [
        {
          id: 'a1',
          consumption: {
            targets: [
              { type: 'itemUses', target: '', value: '1' },
              {
                type: 'material',
                target: 'x',
                value: '2',
                toObject() {
                  return { type: 'material', target: 'x', value: '2' };
                },
              },
            ],
          },
        },
      ],
      uses: { label: 'Recharge 5–6' },
    },
  };
}

/** The row the old eval script wrote (mcp-server src/fork/recharge.test.ts pinned it). */
const EXPECTED_ROW = {
  _id: 'I1',
  'system.uses': {
    max: '1',
    spent: 0,
    recovery: [{ period: 'recharge', formula: '5', type: 'recoverAll' }],
  },
  'system.activities.a1.consumption.targets': [
    { type: 'material', target: 'x', value: '2' },
    { type: 'itemUses', target: '', value: '1' },
  ],
};

describe('rechargeUpdate', () => {
  it('builds the row the eval script built', () => {
    expect(rechargeUpdate(fixtureItem(), 5)).toEqual(EXPECTED_ROW);
  });

  it('an item without activities only gets uses', () => {
    expect(rechargeUpdate({ id: 'I2', system: {} }, 6)).toEqual({
      _id: 'I2',
      'system.uses': {
        max: '1',
        spent: 0,
        recovery: [{ period: 'recharge', formula: '6', type: 'recoverAll' }],
      },
    });
  });
});

describe('foundry-mcp-bridge.fork.applyRecharge', () => {
  const Q = 'foundry-mcp-bridge.fork.applyRecharge';
  let FoundryDataAccess: any;
  beforeAll(async () => {
    (globalThis as any).game = {};
    ({ FoundryDataAccess } = await import('../data-access.js'));
  });

  /** World actor "Ogre" (O1) with the fixture item; scene token T1 whose synthetic actor has its own copy. */
  function world() {
    const updates: { actor: string; rows: any[] }[] = [];
    const mkActor = (id: string, name: string) => {
      const item = fixtureItem();
      const items = Object.assign([item], {
        get: (i: string) => (i === 'I1' ? item : undefined),
      });
      return {
        id,
        name,
        items,
        updateEmbeddedDocuments: async (_t: string, rows: any[]) => {
          updates.push({ actor: name, rows });
        },
      };
    };
    const ogre = mkActor('O1', 'Ogre');
    const synthetic = mkActor('O1', 'Ogre (token T1)');
    const actors = Object.assign([ogre], {
      get: (id: string) => (id === 'O1' ? ogre : undefined),
      getName: (n: string) => (n === 'Ogre' ? ogre : undefined),
    });
    const scenes = [
      { tokens: { get: (id: string) => (id === 'T1' ? { actor: synthetic } : undefined) } },
    ];
    return { game: { user: { isGM: true }, actors, scenes }, updates };
  }

  let w: ReturnType<typeof world>;
  let q: (data: any, ctx?: any) => Promise<any>;
  beforeEach(() => {
    w = world();
    (globalThis as any).game = w.game;
    (globalThis as any).CONFIG = { queries: {} };
    const dataAccess = Object.create(FoundryDataAccess.prototype);
    dataAccess.moduleId = 't';
    (globalThis as any).window = { foundryMCPBridge: { dataAccess } };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    registerForkHandlers();
    q = (globalThis as any).CONFIG.queries[Q];
  });
  afterEach(() => {
    unregisterForkHandlers();
    delete (globalThis as any).window;
    vi.restoreAllMocks();
  });

  it('applies the row to the world actor and returns the label', async () => {
    const res = await q({ actorIdentifier: 'Ogre', itemId: 'I1', featureName: 'Breath', n: 5 });
    expect(res).toEqual({ ok: true, label: 'Recharge 5–6', actorId: 'O1', itemId: 'I1' });
    expect(w.updates).toEqual([{ actor: 'Ogre', rows: [EXPECTED_ROW] }]);
  });

  it('a scene token id resolves to that token\'s actor (was "actor not found")', async () => {
    const res = await q({ actorIdentifier: 'T1', featureName: 'Breath', n: 5 });
    expect(res.ok).toBe(true);
    expect(w.updates).toEqual([{ actor: 'Ogre (token T1)', rows: [EXPECTED_ROW] }]);
  });

  it('refusals are values', async () => {
    expect(await q({ actorIdentifier: 'Nobody', featureName: 'Breath', n: 5 })).toEqual({
      ok: false,
      error: 'actor not found',
    });
    expect(await q({ actorIdentifier: 'Ogre', featureName: 'Nope', n: 5 })).toEqual({
      ok: false,
      error: 'feature not found',
    });
    expect(await q({ actorIdentifier: 'Ogre', featureName: 'Breath', n: 7 })).toEqual({
      ok: false,
      error: 'n must be 2-6',
    });
    delete (globalThis as any).window.foundryMCPBridge.dataAccess;
    expect((await q({ actorIdentifier: 'Ogre', featureName: 'Breath', n: 5 })).error).toBe(
      'bridge data access is not ready'
    );
    expect(w.updates).toEqual([]);
  });

  it('is GM-guarded like eval', async () => {
    await expect(
      q({ actorIdentifier: 'Ogre', featureName: 'Breath', n: 5 }, { user: { isGM: false } })
    ).rejects.toMatchObject({ code: 'NOT_GM' });
    expect(w.updates).toEqual([]);
  });
});
