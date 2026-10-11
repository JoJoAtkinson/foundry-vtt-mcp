/**
 * dnd5e-add-feature's `recharge` (mcp-fork-10), server side: one typed fork query,
 * `foundry-mcp-bridge.fork.applyRecharge` (packages/foundry-module/src/fork/handlers.ts),
 * which resolves the actor the way the creating tool did (token ids included), finds the
 * item by id, and writes the row from foundry-module's `rechargeUpdate`.
 *
 * Kept out of add-feature.ts (an upstream file) so that file carries a 3-line call. The
 * outcome is written to the action log as its own line beside the add-feature call.
 */

import type { FoundryClient } from '../foundry-client.js';
import type { Logger } from '../logger.js';
import { ActionLog } from './action-log.js';

export const APPLY_RECHARGE_QUERY = 'foundry-mcp-bridge.fork.applyRecharge';

export interface RechargeRequest {
  actorIdentifier: string;
  /** The created feature's id when the tool knows it; else the last item named featureName. */
  itemId?: string;
  featureName: string;
  n: number;
}

let sharedLog: ActionLog | undefined;

/**
 * Apply Recharge n–6 and say how it went, as the text add-feature appends to its message:
 * the dnd5e label ("Recharge 5–6") or `not applied (<why>)`. Never throws.
 */
export async function applyRecharge(
  foundryClient: Pick<FoundryClient, 'query'>,
  req: RechargeRequest,
  logger: Logger,
  actionLog: ActionLog = (sharedLog ??= ActionLog.fromEnv(logger))
): Promise<string> {
  const started = Date.now();
  let note: string;
  let ok = false;
  try {
    const r: any = await foundryClient.query(APPLY_RECHARGE_QUERY, req);
    if (r?.ok === false || !r) {
      note = `not applied (${r?.error ?? 'no answer'})`;
    } else {
      ok = true;
      note = r.label ?? `Recharge ${req.n}–6`;
    }
  } catch (err: any) {
    note = `not applied (${err?.message ?? err})`;
  }
  actionLog.append('actions', {
    ts: new Date().toISOString(),
    tool: 'dnd5e-add-feature',
    action: 'recharge',
    args: req,
    ok,
    summary: note,
    ms: Date.now() - started,
  });
  return note;
}
