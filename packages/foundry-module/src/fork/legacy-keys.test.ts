// mcp-fork-18: removeSensitiveFields drops dnd5e's deprecated movement/senses accessors.
// Characterised through the real FoundryDataAccess method (no Foundry needed for it).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { DND5E_LEGACY_MOVEMENT_KEYS } from './legacy-keys.js';

let da: any;
beforeAll(async () => {
  (globalThis as any).game = {};
  (globalThis as any).CONFIG = { queries: {} };
  (globalThis as any).ui = {};
  (globalThis as any).Hooks = { on: () => {}, once: () => {} };
  const { FoundryDataAccess } = await import('../data-access.js');
  da = Object.create(FoundryDataAccess.prototype);
  da.moduleId = 't';
});

const clean = (o: unknown) => da.removeSensitiveFields(o);

describe('removeSensitiveFields: dnd5e legacy keys', () => {
  it('dnd5e 6 movement: keeps speeds, drops the shimmed legacy keys', () => {
    expect(clean({ movement: { speeds: { walk: 30 }, walk: 30, fly: 0, units: 'ft' } })).toEqual({
      movement: { speeds: { walk: 30 }, units: 'ft' },
    });
  });

  it('pre-6 movement (no speeds) is unchanged', () => {
    expect(clean({ movement: { walk: 30, fly: 10 } })).toEqual({ movement: { walk: 30, fly: 10 } });
  });

  it('dnd5e 5.3 senses: keeps ranges, drops the legacy keys', () => {
    expect(clean({ senses: { ranges: { darkvision: 60 }, darkvision: 60 } })).toEqual({
      senses: { ranges: { darkvision: 60 } },
    });
  });

  it('a Set becomes an array', () => {
    expect(clean({ props: new Set(['mgc']) })).toEqual({ props: ['mgc'] });
  });
});

describe('DND5E_LEGACY_MOVEMENT_KEYS (mcp-fork-18)', () => {
  it('holds the six legacy keys', () => {
    expect([...DND5E_LEGACY_MOVEMENT_KEYS].sort()).toEqual([
      'burrow',
      'climb',
      'fly',
      'jump',
      'swim',
      'walk',
    ]);
  });

  it('the sanitizer consults the one shared Set (no per-node list)', () => {
    const has = vi.spyOn(DND5E_LEGACY_MOVEMENT_KEYS as Set<string>, 'has');
    const actors = Array.from({ length: 50 }, () => ({
      movement: { speeds: { walk: 30 }, walk: 30, fly: 0, units: 'ft' },
    }));
    clean(actors);
    // 50 shape checks (stop at 'walk') + 50 x 4 key filters, all on the shared instance
    expect(has.mock.calls.length).toBe(50 * 2 + 50 * 4);
    has.mockRestore();
  });
});
