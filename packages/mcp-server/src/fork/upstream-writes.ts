/**
 * Which upstream (non-fork) tools change the world, so their calls reach the action log.
 *
 * Upstream tools are dispatched by backend.ts's own switch and never pass through the
 * fork registry; the backend's three `fork:` audit hunks hand every call to
 * `ForkRegistry.auditUpstream`, which logs the ones matching these globs (same `*`-only
 * syntax as FOUNDRY_MCP_TOOL_FILTER). A read tool matched by mistake would only add log
 * lines; registry.test.ts pins the upstream list both ways.
 *
 * Every upstream tool backend.ts actually serves must be classified: a write (matches a
 * glob) or a read (named in UPSTREAM_READ_TOOLS). upstream-writes.test.ts builds the real
 * upstream tool classes and fails, naming the tool, when an upstream rebase adds one that
 * is neither — decide which it is and add it to the globs or the read list.
 */

import { globToRegExp } from './glob.js';

export const UPSTREAM_WRITE_GLOBS: readonly string[] = Object.freeze([
  'create-*',
  'update-*',
  'delete-*',
  'manage-*',
  'dnd5e-*',
  'wfrp4e-*',
  'move-token',
  'toggle-token-condition',
  'switch-scene',
  'use-item',
  'assign-actor-ownership',
  'remove-actor-ownership',
  'link-quest-to-npc',
  'request-player-rolls',
  'generate-map',
  'cancel-map-job',
]);

/** Upstream tools that only read the world, so they stay out of the action log. */
export const UPSTREAM_READ_TOOLS: readonly string[] = Object.freeze([
  'check-map-status',
  'get-available-conditions',
  'get-character',
  'get-character-entity',
  'get-compendium-entry-full',
  'get-compendium-item',
  'get-current-scene',
  'get-token-details',
  'get-world-info',
  'list-actor-ownership',
  'list-characters',
  'list-compendium-packs',
  'list-creatures-by-criteria',
  'list-dsa5-archetypes',
  'list-journals',
  'list-scenes',
  'search-character-items',
  'search-compendium',
  'search-journals',
]);

const matchers = UPSTREAM_WRITE_GLOBS.map(globToRegExp);

export function isUpstreamWrite(name: string): boolean {
  return matchers.some(re => re.test(name));
}
