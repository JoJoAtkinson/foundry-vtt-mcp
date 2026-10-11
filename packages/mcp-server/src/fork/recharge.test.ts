import { describe, it, expect, vi, afterEach } from 'vitest';
import { DnD5eAddFeatureTool } from '../tools/dnd5e/add-feature.js';

const logger: any = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

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

/** The row every implementation must write for fixtureItem() and n = 5. */
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

/** A world with one actor "Ogre" (id O1) holding the fixture item; unlinked token T1 on a scene. */
function fakeWorld() {
  const updates: any[] = [];
  const item = fixtureItem();
  const items = Object.assign([item], { get: (id: string) => (id === 'I1' ? item : undefined) });
  const actor = {
    id: 'O1',
    name: 'Ogre',
    items,
    updateEmbeddedDocuments: async (_t: string, rows: any[]) => updates.push(...rows),
  };
  const actors = Object.assign([actor], {
    get: (id: string) => (id === 'O1' ? actor : undefined),
    getName: (n: string) => (n === 'Ogre' ? actor : undefined),
  });
  const synthetic = { ...actor, id: 'O1', name: 'Ogre (token)' };
  const scenes = [
    { tokens: { get: (id: string) => (id === 'T1' ? { actor: synthetic } : undefined) } },
  ];
  return { game: { actors, scenes }, updates, synthetic };
}

describe('recharge, as applied through fork.eval (characterisation, mcp-fork-10)', () => {
  afterEach(() => {
    delete (globalThis as any).game;
  });

  /** A client whose fork.eval runs the script against the fake world, like the GM tab would. */
  function evalClient(world: any) {
    const calls: any[] = [];
    const query = vi.fn(async (method: string, data: any) => {
      calls.push({ method, data });
      (globalThis as any).game = world.game;
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const result = await new AsyncFunction(data.script)();
      return { ok: true, phase: 'complete', result };
    });
    return { query, calls };
  }

  it('writes the recharge row and returns the label', async () => {
    const world = fakeWorld();
    const client = evalClient(world);
    const tool = new DnD5eAddFeatureTool({ foundryClient: client as any, logger });
    const note = await (tool as any).applyRecharge('Ogre', 'Breath', 5);
    expect(client.calls[0].method).toBe('foundry-mcp-bridge.fork.eval');
    expect(world.updates).toEqual([EXPECTED_ROW]);
    expect(note).toBe('Recharge 5–6');
  });

  it('a scene token id is not resolved (the bug mcp-fork-10 fixes)', async () => {
    const world = fakeWorld();
    const tool = new DnD5eAddFeatureTool({ foundryClient: evalClient(world) as any, logger });
    expect(await (tool as any).applyRecharge('T1', 'Breath', 5)).toBe(
      'not applied (actor not found)'
    );
    expect(world.updates).toEqual([]);
  });

  it('a missing feature, a failed eval and a transport error read as not applied', async () => {
    const world = fakeWorld();
    const tool = new DnD5eAddFeatureTool({ foundryClient: evalClient(world) as any, logger });
    expect(await (tool as any).applyRecharge('Ogre', 'Nope', 5)).toBe(
      'not applied (feature not found)'
    );
    const failing = new DnD5eAddFeatureTool({
      foundryClient: { query: async () => ({ ok: false, error: 'x' }) } as any,
      logger,
    });
    expect(await (failing as any).applyRecharge('Ogre', 'Breath', 5)).toBe('not applied (x)');
    const throwing = new DnD5eAddFeatureTool({
      foundryClient: {
        query: async () => {
          throw new Error('Foundry VTT module not connected');
        },
      } as any,
      logger,
    });
    expect(await (throwing as any).applyRecharge('Ogre', 'Breath', 5)).toBe(
      'not applied (Foundry VTT module not connected)'
    );
  });
});
