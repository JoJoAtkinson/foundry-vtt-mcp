/**
 * Rebase guard for the upstream write globs (ext-6).
 *
 * The action log only sees upstream tools whose names match UPSTREAM_WRITE_GLOBS. Pinning
 * those globs against a hand-typed list (registry.test.ts) says nothing about a tool an
 * upstream rebase adds: it would be served, unlogged, and no test would notice. This test
 * builds every upstream tool class backend.ts spreads into its tool list, collects the
 * names actually served, and requires each one to be classified — a write (matches a glob)
 * or a read (listed in UPSTREAM_READ_TOOLS). An unclassified name fails with its name.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { UPSTREAM_READ_TOOLS, UPSTREAM_WRITE_GLOBS, isUpstreamWrite } from './upstream-writes.js';
import { CharacterTools } from '../tools/character.js';
import { CompendiumTools } from '../tools/compendium.js';
import { SceneTools } from '../tools/scene.js';
import { ActorCreationTools } from '../tools/actor-creation.js';
import { ActorManagementTools } from '../tools/actor-management.js';
import { QuestCreationTools } from '../tools/quest-creation.js';
import { DiceRollTools } from '../tools/dice-roll.js';
import { CampaignManagementTools } from '../tools/campaign-management.js';
import { OwnershipTools } from '../tools/ownership.js';
import { WFRP4eUpdateActorTools } from '../tools/wfrp4e/update-actor.js';
import { WFRP4eAddItemsTools } from '../tools/wfrp4e/add-items.js';
import { MapGenerationTools } from '../tools/map-generation.js';
import { TokenManipulationTools } from '../tools/token-manipulation.js';
import { DSA5CharacterCreator } from '../systems/dsa5/character-creator.js';
import { DnD5eAddFeatureTool } from '../tools/dnd5e/add-feature.js';
import { DnD5eNpcTools } from '../tools/dnd5e/npc.js';
import { DnD5eFeaturesFromCompendiumTools } from '../tools/dnd5e/features.js';
import { getSystemRegistry } from '../systems/index.js';

const logger: any = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};
const foundryClient: any = {
  query: vi.fn(async () => {
    throw new Error('no Foundry in this test');
  }),
  sendMessage: vi.fn(),
};
const systemRegistry = getSystemRegistry(logger);

// One entry per `...<name>.getToolDefinitions()` spread in backend.ts (forkRegistry aside).
const UPSTREAM_TOOL_SETS: Record<string, { getToolDefinitions(): Array<{ name: string }> }> = {
  characterTools: new CharacterTools({ foundryClient, logger, systemRegistry }),
  compendiumTools: new CompendiumTools({ foundryClient, logger, systemRegistry }),
  sceneTools: new SceneTools({ foundryClient, logger }),
  actorCreationTools: new ActorCreationTools({ foundryClient, logger }),
  actorManagementTools: new ActorManagementTools({ foundryClient, logger, systemRegistry }),
  dsa5CharacterCreator: new DSA5CharacterCreator({ foundryClient, logger }),
  dnd5eAddFeatureTool: new DnD5eAddFeatureTool({ foundryClient, logger }),
  dnd5eNpcTools: new DnD5eNpcTools({ foundryClient, logger }),
  dnd5eFeaturesFromCompendiumTools: new DnD5eFeaturesFromCompendiumTools({
    foundryClient,
    logger,
  }),
  questCreationTools: new QuestCreationTools({ foundryClient, logger }),
  diceRollTools: new DiceRollTools({ foundryClient, logger }),
  campaignManagementTools: new CampaignManagementTools(foundryClient, logger),
  ownershipTools: new OwnershipTools({ foundryClient, logger }),
  wfrp4eUpdateActorTools: new WFRP4eUpdateActorTools({ foundryClient, logger }),
  wfrp4eAddItemsTools: new WFRP4eAddItemsTools({ foundryClient, logger }),
  tokenManipulationTools: new TokenManipulationTools({ foundryClient, logger }),
  mapGenerationTools: new MapGenerationTools({ foundryClient, logger }),
};

function servedUpstreamNames(): string[] {
  const names = Object.values(UPSTREAM_TOOL_SETS).flatMap(set =>
    set.getToolDefinitions().map(t => t.name)
  );
  return [...new Set(names)].sort();
}

describe('every served upstream tool is classified write or read (ext-6)', () => {
  it('this test builds exactly the tool sets backend.ts spreads into its tool list', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const backend = readFileSync(join(here, '..', 'backend.ts'), 'utf8');
    const spread = [...backend.matchAll(/\.\.\.(\w+)\.getToolDefinitions\(\)/g)]
      .map(m => m[1]!)
      .filter(n => n !== 'forkRegistry')
      .sort();
    expect(spread.length).toBeGreaterThan(0);
    expect(Object.keys(UPSTREAM_TOOL_SETS).sort()).toEqual(spread);
  });

  it('no served upstream tool name is unclassified', () => {
    const served = servedUpstreamNames();
    expect(served.length).toBeGreaterThan(0);
    const reads = new Set(UPSTREAM_READ_TOOLS);
    const unclassified = served.filter(n => !isUpstreamWrite(n) && !reads.has(n));
    expect(unclassified, 'ext-6: classify these in upstream-writes.ts').toEqual([]);
  });

  it('no tool is both a write and a read, and the read list names only served tools', () => {
    const served = new Set(servedUpstreamNames());
    expect(UPSTREAM_READ_TOOLS.filter(isUpstreamWrite)).toEqual([]);
    expect(UPSTREAM_READ_TOOLS.filter(n => !served.has(n))).toEqual([]);
    expect(UPSTREAM_WRITE_GLOBS.length).toBeGreaterThan(0);
  });
});
