/**
 * dnd5e-add-feature's `recharge` (mcp-fork-10), server side: one typed fork query,
 * `foundry-mcp-bridge.fork.applyRecharge` (packages/foundry-module/src/fork/handlers.ts),
 * which resolves the actor exactly (id, exact name, token id; then the created actor's id —
 * never a substring), finds the item by id, and writes the row from foundry-module's
 * `rechargeUpdate`.
 *
 * Kept out of add-feature.ts (an upstream file) so that file carries a 3-line call. The
 * outcome is not logged here: add-feature puts the note on its result as `recharge`, and
 * the registry's upstream-write line for that call (auditUpstream) carries it, with the
 * call's args (sanitised) and client — one line, one ActionLog.
 */

import type { FoundryClient } from '../foundry-client.js';
import type { Logger } from '../logger.js';

export const APPLY_RECHARGE_QUERY = 'foundry-mcp-bridge.fork.applyRecharge';

export interface RechargeRequest {
  actorIdentifier: string;
  /**
   * The id of the actor the feature was created on (the tool's result). The module resolves
   * the identifier exactly and falls back to this id, so a substring never picks the actor.
   */
  actorId?: string;
  /** The created feature's id when the tool knows it; else the last item named featureName. */
  itemId?: string;
  featureName: string;
  n: number;
}

/**
 * Apply Recharge n–6 and say how it went, as the text add-feature appends to its message
 * and puts on its result as `recharge`: the dnd5e label ("Recharge 5–6") or
 * `not applied (<why>)`. Never throws.
 */
export async function applyRecharge(
  foundryClient: Pick<FoundryClient, 'query'>,
  req: RechargeRequest,
  logger: Logger
): Promise<string> {
  let note: string;
  try {
    const r: any = await foundryClient.query(APPLY_RECHARGE_QUERY, req);
    if (r?.ok === false || !r) {
      note = `not applied (${r?.error ?? 'no answer'})`;
    } else {
      note = r.label ?? `Recharge ${req.n}–6`;
    }
  } catch (err: any) {
    note = `not applied (${err?.message ?? err})`;
  }
  logger.debug(`dnd5e-add-feature recharge: ${note}`);
  return note;
}
