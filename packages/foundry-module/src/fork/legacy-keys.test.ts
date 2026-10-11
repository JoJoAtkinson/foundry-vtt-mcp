// mcp-fork-18: removeSensitiveFields drops dnd5e's deprecated movement/senses accessors.
// Characterised through the real FoundryDataAccess method (no Foundry needed for it).
import { describe, it, expect, beforeAll } from 'vitest';

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
