/**
 * toggle-token-condition: "active omitted = toggle" (2026-10-11 live checks).
 *
 * The tool's schema (mcp-server tools/token-manipulation.ts) documents `active` as optional
 * — "If not specified, will toggle the current state" — but upstream's browser handler
 * rejects a missing `active` ("active must be a boolean"). Rather than edit upstream's
 * queries.ts/data-access.ts, the fork's bridge-query wrapper (handlers.ts) fills `active`
 * in before upstream sees the call: true when the token's actor has no effect for the
 * condition, false when it has one. The match is the one upstream uses to remove a
 * condition (status id, then name, then label, case-insensitive), plus the resolved
 * CONFIG.statusEffects id when the caller named the condition.
 *
 * Best effort, never throws: a token or actor that cannot be found gets `active: true`, so
 * upstream raises its own "Token … not found" error instead of the boolean complaint.
 */

declare const game: any;
declare const CONFIG: any;

export const TOGGLE_KEYS = new Set([
  'foundry-mcp-bridge.toggle-token-condition',
  'foundry-mcp-bridge.toggleTokenCondition',
]);

export function withToggleDefault<T extends Record<string, any>>(data: T): T {
  if (!data || typeof data !== 'object' || typeof data.active === 'boolean') return data;
  let active = true;
  try {
    const wanted = String(data.conditionId ?? '').toLowerCase();
    const condition = (CONFIG?.statusEffects ?? []).find(
      (c: any) => c?.id === data.conditionId || c?.name?.toLowerCase?.() === wanted
    );
    const ids = new Set([data.conditionId, condition?.id].filter(Boolean));
    const actor = game?.scenes?.current?.tokens?.get?.(data.tokenId)?.actor;
    const effects: any[] = actor?.effects?.contents ?? [];
    const has = effects.some(
      (e: any) =>
        [...ids].some(id => e?.statuses?.has?.(id)) ||
        (wanted !== '' &&
          (e?.name?.toLowerCase?.() === wanted || e?.label?.toLowerCase?.() === wanted))
    );
    if (actor) active = !has;
  } catch {
    active = true;
  }
  return { ...data, active };
}
