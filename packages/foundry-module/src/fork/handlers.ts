/**
 * Fork query handlers — module side.
 *
 * Upstream's module dispatch (`CONFIG.queries`) is already a generic name-keyed
 * registry, so the fork's query handlers register into it from here instead of
 * growing data-access.ts (10k+ lines, the main rebase hazard); the remaining
 * data-access.ts edits are the dnd5e 6 shims and request-player-rolls fixes
 * listed in FORK.md.
 *
 * Everything here runs inside a logged-in GM's browser session.
 */

const MODULE_ID = 'foundry-mcp-bridge';
const FORK_PREFIX = `${MODULE_ID}.fork`;

import { rechargeUpdate } from './recharge.js';
import { serialize } from './serialize.js';
import { TOGGLE_KEYS, withToggleDefault } from './toggle-condition.js';

declare const game: any;
declare const CONFIG: any;

/**
 * Two callers reach a CONFIG.queries handler:
 *  - the MCP bridge (socket-bridge.ts) calls `handler(data)` with no context, from this
 *    GM's own browser — so the running client's GM status is the check;
 *  - Foundry's User#query calls `handler(data, {user, timeout})` on behalf of ANOTHER
 *    user. Every player role holds QUERY_USER, so without the `ctx.user` check any
 *    player could run arbitrary JS in the GM's browser via
 *    `game.users.activeGM.query("foundry-mcp-bridge.fork.eval", {script})`.
 */
function requireGM(ctx?: QueryContext): void {
  if (!game.user?.isGM) {
    throw notGM('fork tools require a GM session.');
  }
  assertSenderIsGM(ctx, 'fork tools');
}

/**
 * The kit's coded-error form (pentaryn foundry/lib/errors.mjs): the `NOT_GM:` prefix is
 * the wire format (a query error crosses the socket as its message only) and `code` is
 * set for local callers. "Access denied" stays in the text for anyone matching on it.
 */
function notGM(detail: string): Error {
  return Object.assign(new Error(`NOT_GM: Access denied: ${detail}`), { code: 'NOT_GM' });
}

type QueryContext = { user?: { isGM?: boolean } };

/** The sender half of the guard: a User#query from a non-GM is refused; no ctx passes. */
function assertSenderIsGM(ctx: QueryContext | undefined, what: string): void {
  if (ctx?.user && !ctx.user.isGM) {
    throw notGM(`${what} may only be queried by a GM.`);
  }
}

/**
 * Upstream's `foundry-mcp-bridge.*` handlers check only `game.user.isGM` — true in the GM
 * tab whoever sent the query — so any player could run `createNpcActor` & co. through
 * `game.users.activeGM.query(...)`. Wrap each of them (once) with the sender check. Calls
 * without a ctx (the bridge socket; pentaryn-prompts calling a handler directly) are
 * unchanged. Other modules' queries and the fork's own (`.fork.*`, guarded by requireGM)
 * are left alone. Runs after upstream's registerHandlers() (main.ts).
 *
 * The toggle-token-condition keys also get `active` filled in when it is omitted
 * (toggle-condition.ts), so the tool's documented "omitted = toggle" works.
 */
function guardBridgeQueries(): void {
  for (const [key, h] of Object.entries(CONFIG.queries as Record<string, any>)) {
    if (!key.startsWith(`${MODULE_ID}.`) || key.startsWith(`${FORK_PREFIX}.`)) continue;
    if (typeof h !== 'function' || h.__forkGuarded) continue;
    const guarded = async (data: unknown, ctx?: QueryContext) => {
      assertSenderIsGM(ctx, 'bridge queries');
      return h(TOGGLE_KEYS.has(key) ? withToggleDefault(data as any) : data, ctx);
    };
    (guarded as any).__forkGuarded = true;
    CONFIG.queries[key] = guarded;
  }
}

/**
 * Evaluate JavaScript inside the Foundry client.
 *
 * Deliberate escape hatch: the whole point is that it has no schema. It exists so
 * unanticipated needs don't block on shipping a tool, and — more importantly —
 * so its LOG becomes the demand signal for which real tools to build next.
 * The eval-js tool logs every call server-side (eval-<YYYY-MM>.jsonl) when
 * PENTARYN_MCP_LOG_DIR is set; this handler does not log.
 */
async function handleEval(
  data: { script: string; timeoutMs?: number },
  ctx?: QueryContext
): Promise<any> {
  requireGM(ctx);

  if (typeof data?.script !== 'string' || !data.script.trim()) {
    throw new Error('script is required and must be a non-empty string');
  }

  const started = Date.now();
  // Async wrapper so `await` works in the submitted script without ceremony.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  let fn: any;
  try {
    fn = new AsyncFunction(`"use strict"; return (async () => { ${data.script} })();`);
  } catch (err: any) {
    return { ok: false, phase: 'compile', error: String(err?.message ?? err) };
  }

  const timeoutMs = Math.min(Math.max(data.timeoutMs ?? 10_000, 1_000), 60_000);

  // The timer is cleared however the race ends, so a fast script leaves nothing pending
  // in the GM tab; a timeout is flagged, because the script itself cannot be stopped.
  const TIMED_OUT = Symbol('timed out');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error(`eval timed out after ${timeoutMs}ms`), {
                [TIMED_OUT]: true,
              })
            ),
          timeoutMs
        );
      }),
    ]);
    return {
      ok: true,
      phase: 'complete',
      ms: Date.now() - started,
      resultType:
        result === undefined ? 'undefined' : Array.isArray(result) ? 'array' : typeof result,
      result: serialize(result),
    };
  } catch (err: any) {
    return {
      ok: false,
      phase: 'runtime',
      ms: Date.now() - started,
      error: String(err?.message ?? err),
      stack: err?.stack?.split('\n').slice(0, 5),
      ...(err?.[TIMED_OUT]
        ? {
            timedOut: true,
            note: 'the script may still be running; re-read state before retrying',
          }
        : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The actor a recharge goes to, resolved exactly — never a substring (an empty or partial
 * identifier must not land on another actor): world actor id, then exact name, then a scene
 * token id (an unlinked token's own synthetic actor). `actorId` is the id the creating tool
 * reported: when the identifier does not resolve to an actor with that id (the creating
 * tool matched a substring), the world actor with that id is the one it wrote to. A
 * synthetic actor shares its base actor's id, so a token id keeps its synthetic actor.
 */
function findRechargeActor(identifier: string, actorId?: string): any {
  let actor: any;
  if (identifier) {
    actor = game.actors?.get?.(identifier) ?? game.actors?.getName?.(identifier);
    if (!actor) {
      for (const scene of game.scenes ?? []) {
        const token = scene.tokens?.get?.(identifier);
        if (token?.actor) {
          actor = token.actor;
          break;
        }
      }
    }
  }
  if (actorId && actor?.id !== actorId) actor = game.actors?.get?.(actorId);
  return actor;
}

/**
 * Give a feature Recharge n–6 (dnd5e-add-feature's `recharge`, mcp-fork-10). The actor is
 * resolved exactly (findRechargeActor), and the item by id when the tool knows it — an id
 * that is not on that actor is "feature not found", never a same-named feature — else the
 * last item with that name.
 */
async function handleApplyRecharge(
  data: {
    actorIdentifier?: string;
    actorId?: string;
    itemId?: string;
    featureName?: string;
    n?: number;
  },
  ctx?: QueryContext
): Promise<{ ok: boolean; error?: string; label?: string; actorId?: string; itemId?: string }> {
  requireGM(ctx);
  const n = Number(data?.n);
  if (!Number.isInteger(n) || n < 2 || n > 6) return { ok: false, error: 'n must be 2-6' };
  const actor = findRechargeActor(
    String(data?.actorIdentifier ?? ''),
    typeof data?.actorId === 'string' && data.actorId ? data.actorId : undefined
  );
  if (!actor) return { ok: false, error: 'actor not found' };
  const item = data?.itemId
    ? actor.items.get(data.itemId)
    : actor.items.filter((i: any) => i.name === data?.featureName).pop();
  if (!item) return { ok: false, error: 'feature not found' };
  await actor.updateEmbeddedDocuments('Item', [rechargeUpdate(item, n)]);
  return {
    ok: true,
    label: actor.items.get(item.id)?.system?.uses?.label,
    actorId: actor.id,
    itemId: item.id,
  };
}

export function registerForkHandlers(): void {
  CONFIG.queries[`${FORK_PREFIX}.eval`] = handleEval;
  CONFIG.queries[`${FORK_PREFIX}.applyRecharge`] = handleApplyRecharge;
  guardBridgeQueries();
  console.log(`[${MODULE_ID}] fork handlers registered`);
}

export function unregisterForkHandlers(): void {
  delete CONFIG.queries[`${FORK_PREFIX}.eval`];
  delete CONFIG.queries[`${FORK_PREFIX}.applyRecharge`];
}
