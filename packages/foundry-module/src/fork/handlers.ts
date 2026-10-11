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
 * Serialize an arbitrary evaluation result for transport back over the bridge.
 *
 * Foundry documents are cyclic and enormous; naive JSON.stringify either throws
 * or ships megabytes. Documents collapse to a useful identity, collections to
 * their contents, and depth is capped.
 */
export function serialize(value: any, depth = 0, seen = new WeakSet()): any {
  if (value === null || value === undefined) return value ?? null;

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (t === 'bigint') return value.toString();
  if (t === 'symbol') return value.toString();

  if (depth > 4) return '[max depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error)
    return { error: value.message, stack: value.stack?.split('\n').slice(0, 4) };

  // Foundry Documents — identity plus source data, not the whole live object.
  if (value.documentName && value._id !== undefined) {
    return {
      _document: value.documentName,
      _id: value._id,
      name: value.name ?? undefined,
      ...(depth === 0 ? { source: safeToObject(value) } : {}),
    };
  }

  // Collections (Map subclasses) — Foundry uses these heavily.
  if (
    value instanceof Map ||
    (typeof value.entries === 'function' && typeof value.size === 'number')
  ) {
    const out: any[] = [];
    let n = 0;
    for (const v of value.values()) {
      if (n++ >= 100) {
        out.push(`[+${value.size - 100} more]`);
        break;
      }
      out.push(serialize(v, depth + 1, seen));
    }
    return out;
  }

  if (value instanceof Set) return [...value].slice(0, 100).map(v => serialize(v, depth + 1, seen));

  if (Array.isArray(value)) {
    if (value.length > 200) {
      return [
        ...value.slice(0, 200).map(v => serialize(v, depth + 1, seen)),
        `[+${value.length - 200} more]`,
      ];
    }
    return value.map(v => serialize(v, depth + 1, seen));
  }

  const out: Record<string, any> = {};
  for (const k of Object.keys(value)) {
    if (k.startsWith('_') && k !== '_id') continue;
    try {
      out[k] = serialize(value[k], depth + 1, seen);
    } catch {
      out[k] = '[unserializable]';
    }
  }
  return out;
}

function safeToObject(doc: any): any {
  try {
    return doc.toObject ? doc.toObject() : undefined;
  } catch {
    return undefined;
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
