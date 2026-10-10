/**
 * dnd5e Adapter Tests — dnd5e 6.x data shapes.
 *
 * dnd5e 6.0 moved movement.walk/fly/... to movement.speeds.* (the legacy keys survive only
 * as shims on live documents, and do not survive the socket's JSON round trip as data the
 * adapter should prefer). The adapter must read speeds from the 6.x shape and still accept
 * the flat pre-6 shape.
 */

import { describe, it, expect } from 'vitest';
import { DnD5eAdapter } from './adapter.js';

// A 6.x druid as the bridge's sanitizer delivers it: movement.speeds present, the enumerable
// legacy shim keys already dropped, `save` objects stripped by safeJSONStringify.
const talo6: any = {
  name: 'Talo',
  type: 'character',
  system: {
    abilities: {
      str: { value: 10, mod: 0 },
      wis: { value: 17, mod: 3 },
    },
    attributes: {
      hp: { value: 30, max: 38, temp: 0 },
      ac: { value: 14 },
      movement: {
        bonus: '',
        special: '',
        units: 'ft',
        hover: false,
        ignoredDifficultTerrain: [],
        speeds: { walk: 30, burrow: 0, climb: 0, fly: 0, jump: 0, swim: 0 },
      },
    },
    details: { level: 5 },
  },
};

describe('DnD5eAdapter.extractCharacterStats — movement', () => {
  const adapter = new DnD5eAdapter();

  it('reads dnd5e 6.x movement.speeds and drops zero speeds', () => {
    const stats = adapter.extractCharacterStats(talo6);
    expect(stats.movement).toEqual({ speeds: { walk: 30 }, units: 'ft' });
  });

  it('keeps custom movement types and hover', () => {
    const actor = structuredClone(talo6);
    actor.system.attributes.movement.speeds = { walk: 30, fly: 60, glide: 20 };
    actor.system.attributes.movement.hover = true;
    const stats = adapter.extractCharacterStats(actor);
    expect(stats.movement).toEqual({
      speeds: { walk: 30, fly: 60, glide: 20 },
      units: 'ft',
      hover: true,
    });
  });

  it('still accepts the flat pre-6 shape', () => {
    const actor = structuredClone(talo6);
    actor.system.attributes.movement = { walk: 25, swim: 25, fly: null, units: 'ft' };
    const stats = adapter.extractCharacterStats(actor);
    expect(stats.movement).toEqual({ speeds: { walk: 25, swim: 25 }, units: 'ft' });
  });

  it('omits movement when the actor has none', () => {
    const actor = structuredClone(talo6);
    delete actor.system.attributes.movement;
    expect(adapter.extractCharacterStats(actor).movement).toBeUndefined();
  });
});
