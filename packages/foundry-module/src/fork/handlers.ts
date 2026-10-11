/**
 * Fork query handlers — module side.
 *
 * Upstream's module dispatch (`CONFIG.queries`) is already a generic name-keyed
 * registry, so the fork registers into it from here and never edits
 * data-access.ts (10k+ lines, the main rebase hazard).
 *
 * Everything here runs inside a logged-in GM's browser session.
 */

const MODULE_ID = 'foundry-mcp-bridge';
const FORK_PREFIX = `${MODULE_ID}.fork`;

import { serialize } from './serialize.js';

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
function requireGM(ctx?: { user?: { isGM?: boolean } }): void {
  if (!game.user?.isGM) {
    throw new Error('Access denied: fork tools require a GM session.');
  }
  if (ctx?.user && !ctx.user.isGM) {
    throw new Error('Access denied: fork tools may only be queried by a GM.');
  }
}

/**
 * Evaluate JavaScript inside the Foundry client.
 *
 * Deliberate escape hatch: the whole point is that it has no schema. It exists so
 * unanticipated needs don't block on shipping a tool, and — more importantly —
 * so its LOG becomes the demand signal for which real tools to build next.
 * Every call is logged server-side regardless of logging configuration.
 */
async function handleEval(
  data: { script: string; timeoutMs?: number },
  ctx?: { user?: { isGM?: boolean } }
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

  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`eval timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
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
    };
  }
}

export function registerForkHandlers(): void {
  CONFIG.queries[`${FORK_PREFIX}.eval`] = handleEval;
  console.log(`[${MODULE_ID}] fork handlers registered`);
}

export function unregisterForkHandlers(): void {
  delete CONFIG.queries[`${FORK_PREFIX}.eval`];
}
