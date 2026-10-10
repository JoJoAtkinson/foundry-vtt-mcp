/**
 * search-compendium / get-compendium-item against dnd5e 6.x data shapes.
 *
 * dnd5e 6.0 replaced the item's `rarity` string with a `rarities` set (raw/index data and
 * the bridge's sanitized output carry it as an array; only live documents have the `rarity`
 * getter) and moved actor speeds under `attributes.movement.speeds`.
 */

import { describe, it, expect, vi } from 'vitest';
import { CompendiumTools } from './compendium.js';

function makeTools(responses: Record<string, unknown>) {
  const query = vi.fn(async (method: string) => {
    if (method === 'foundry-mcp-bridge.getWorldInfo') return { system: { id: 'dnd5e' } };
    if (method in responses) return responses[method];
    throw new Error(`unexpected query ${method}`);
  });
  const logger: any = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return new CompendiumTools({ foundryClient: { query } as any, logger });
}

const entry = (over: any) => ({
  id: 'x',
  name: 'Thing',
  type: 'equipment',
  pack: 'dnd5e.items',
  packLabel: 'Items',
  description: '',
  hasImage: false,
  ...over,
});

describe('search-compendium rarity (dnd5e 6.x index entries)', () => {
  it('shows the rarity word from system.rarities on any physical item type', async () => {
    const tools = makeTools({
      'foundry-mcp-bridge.searchCompendium': [
        entry({
          name: 'Cloak of Protection',
          type: 'equipment',
          system: { rarities: ['uncommon'] },
        }),
        entry({ name: 'Flame Tongue', type: 'weapon', system: { rarities: ['rare'] } }),
        entry({ name: 'Potion of Healing', type: 'consumable', system: { rarities: ['common'] } }),
        entry({ name: 'Rope', type: 'loot' }),
      ],
    });
    const res = await tools.handleSearchCompendium({ query: 'magic' });
    const byName = Object.fromEntries(res.results.map((r: any) => [r.name, r.summary]));
    expect(byName['Cloak of Protection']).toContain('uncommon');
    expect(byName['Flame Tongue']).toContain('rare');
    expect(byName['Potion of Healing']).toContain('common');
    expect(byName['Rope']).toBe('loot from Items');
  });

  it('joins multiple rarities and still reads a pre-6 rarity string', async () => {
    const tools = makeTools({
      'foundry-mcp-bridge.searchCompendium': [
        entry({ name: 'Belt of Giant Strength', system: { rarities: ['rare', 'veryRare'] } }),
        entry({ name: 'Old Pack Item', system: { rarity: 'uncommon' } }),
        entry({ name: 'Lost Set', system: { rarities: {} } }), // a Set flattened by JSON
      ],
    });
    const res = await tools.handleSearchCompendium({ query: 'magic' });
    const byName = Object.fromEntries(res.results.map((r: any) => [r.name, r.summary]));
    expect(byName['Belt of Giant Strength']).toContain('rare/veryRare');
    expect(byName['Old Pack Item']).toContain('uncommon');
    expect(byName['Lost Set']).toBe('equipment from Items');
  });
});

describe('get-compendium-item (dnd5e 6.x documents)', () => {
  it('reports properties.rarity from rarities', async () => {
    const tools = makeTools({
      'foundry-mcp-bridge.getCompendiumDocumentFull': entry({
        name: 'Cloak of Protection',
        system: { rarities: ['uncommon'], price: { value: 500, denomination: 'gp' } },
      }),
    });
    const res = await tools.handleGetCompendiumItem({ packId: 'dnd5e.items', itemId: 'x' });
    expect(res.properties.rarity).toBe('uncommon');
  });

  it('compact stats read speeds from movement.speeds', async () => {
    const tools = makeTools({
      'foundry-mcp-bridge.getCompendiumDocumentFull': entry({
        name: 'Giant Eagle',
        type: 'npc',
        system: {
          attributes: {
            movement: { units: 'ft', speeds: { walk: 10, fly: 80, swim: 0 } },
          },
        },
      }),
    });
    const res = await tools.handleGetCompendiumItem({
      packId: 'dnd5e.monsters',
      itemId: 'x',
      compact: true,
    });
    expect(res.stats.speed).toBe('10 ft, fly 80 ft');
  });
});
