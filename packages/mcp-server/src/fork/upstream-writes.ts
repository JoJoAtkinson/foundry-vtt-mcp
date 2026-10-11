/**
 * Which upstream (non-fork) tools change the world, so their calls reach the action log.
 *
 * Upstream tools are dispatched by backend.ts's own switch and never pass through the
 * fork registry; the backend's three `fork:` audit hunks hand every call to
 * `ForkRegistry.auditUpstream`, which logs the ones matching these globs (same `*`-only
 * syntax as FOUNDRY_MCP_TOOL_FILTER). A read tool matched by mistake would only add log
 * lines; registry.test.ts pins the upstream list both ways.
 */

import { globToRegExp } from './registry.js';

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

// Built on first use: registry.ts imports this file, and this file imports registry.ts.
let matchers: RegExp[] | null = null;

export function isUpstreamWrite(name: string): boolean {
  matchers ??= UPSTREAM_WRITE_GLOBS.map(globToRegExp);
  return matchers.some(re => re.test(name));
}
