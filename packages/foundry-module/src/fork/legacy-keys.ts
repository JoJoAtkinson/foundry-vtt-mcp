/**
 * dnd5e 6.0 moved actor movement to `movement.speeds.*`; its MovementField shim re-adds
 * the legacy keys as enumerable accessors. data-access.ts's removeSensitiveFields drops
 * them when `speeds` is present. One module-scope Set (mcp-fork-18): the sanitizer
 * visits every node of an actor payload, and used to allocate this list per node.
 * (The matching dnd5e 5.3 senses list is upstream's and stays where it is.)
 */
export const DND5E_LEGACY_MOVEMENT_KEYS: ReadonlySet<string> = new Set([
  'walk',
  'burrow',
  'climb',
  'fly',
  'jump',
  'swim',
]);
