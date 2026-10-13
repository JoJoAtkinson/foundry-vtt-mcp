/**
 * toggle-token-condition: "active omitted = toggle" (2026-10-11 live checks).
 *
 * The tool's schema (mcp-server tools/token-manipulation.ts) documents `active` as optional
 * — "If not specified, will toggle the current state" — but upstream's browser handler
 * rejects a missing `active` ("active must be a boolean"). Rather than edit upstream's
 * queries.ts/data-access.ts, the fork's bridge-query wrapper (handlers.ts) fills `active`
 * in before upstream sees the call: true when the token's actor has no effect for the
 * condition, false when it has one. The match is the one upstream uses to remove a
 * condition, and only that: the raw `conditionId` in the effect's statuses, or the effect's
 * name/label equal to it case-insensitively. It deliberately does not match the resolved
 * CONFIG.statusEffects id (fork-edge-4): upstream's removal never does, so a name that only
 * matches through it would default to a removal that removes nothing; it applies instead.
 *
 * Only an omitted `active` (absent or undefined) is filled in (rob-4). Any other value — a
 * string, null, a number — passes through unchanged, so upstream's own "active must be a
 * boolean" refuses it rather than the wrapper silently replacing it with a toggle.
 *
 * Best effort, never throws: a token or actor that cannot be found gets `active: true`, so
 * upstream raises its own "Token … not found" error instead of the boolean complaint.
 */

declare const game: any;

export const TOGGLE_KEYS = new Set([
  'foundry-mcp-bridge.toggle-token-condition',
  'foundry-mcp-bridge.toggleTokenCondition',
]);

export function withToggleDefault<T extends Record<string, any>>(data: T): T {
  if (!data || typeof data !== 'object' || data.active !== undefined) return data;
  let active = true;
  try {
    const wanted = String(data.conditionId ?? '').toLowerCase();
    const actor = game?.scenes?.current?.tokens?.get?.(data.tokenId)?.actor;
    const effects: any[] = actor?.effects?.contents ?? [];
    const has = effects.some(
      (e: any) =>
        (data.conditionId != null && e?.statuses?.has?.(data.conditionId)) ||
        (wanted !== '' &&
          (e?.name?.toLowerCase?.() === wanted || e?.label?.toLowerCase?.() === wanted))
    );
    if (actor) active = !has;
  } catch {
    active = true;
  }
  return { ...data, active };
}
