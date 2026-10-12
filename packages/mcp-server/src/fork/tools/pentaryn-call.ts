/**
 * pentaryn-call — the one browser-side script behind `pentaryn-read` and `pentaryn-write`
 * (D14, decision D3 of the blueprint design record; pentaryn repo
 * context/plans/addon-blueprint-2026-10/wave-2-bridge-plan.md §3).
 *
 * Transport is the existing GM-guarded `foundry-mcp-bridge.fork.eval` query, so the bridge
 * module needs no new handler. The script is a FIXED template whose only variable part is
 * one JSON literal (`const call = {...}`): no JavaScript is ever built from caller strings.
 *
 * In the GM tab the template reads `game.pentaryn[ns].describe()` on every call (no
 * fork-side cache that can drift), finds the row, refuses a write row on the read tool and
 * a read row on the write tool (a row runs as a read only when it says `writes: false`, and
 * as a write only when it says `writes: true`), maps the call onto the row's parameters, runs it, and turns
 * a thrown coded error into a value. The module resolves `ref` (exact match, never a
 * substring); the fork passes it through unchanged.
 *
 * Calling convention (from the row's `params`, in order):
 *   - a param named `ref`              ← the call's `ref`
 *   - a param named `opts` / `options` ← the call's `opts` (+ `dryRun: true` from the write
 *     tool) minus any keys taken positionally
 * A dry run (the write tool's `dryRun`, or a truthy `opts.dryRun`) is forwarded only to a row
 * that declares one: `row.dryRun === true` (a kit field, not yet in kit 1.0.2), or a param
 * whose type or doc names `dryRun` (importer.import's options). Any other write row refuses
 * it with BAD_ARGS before it runs: walls.run(opts) would ignore the flag and run for real.
 *   - any other param                  ← `opts[<its name>]` (e.g. rules.search(query, opts):
 *     `{opts: {query: "grapple", limit: 3}}`)
 * Opts keys left over on a row without an opts param, or a `ref` on a row without one, are
 * refused with BAD_ARGS. The root describe ({ns: "*", path: "describe"}) takes neither: a `ref`
 * or non-empty `opts` there is BAD_ARGS too (fork-edge-6); the root inspect takes both. A param that needs a live Document cannot be passed as JSON, so a
 * call that would fill one is refused with BAD_ARGS ('needs a live Document — eval-js only')
 * before it runs. A param needs one when it is a Document (a `kind` the kit resolves, a
 * `type` made only of Document class names such as "Actor" or "JournalEntry|Item", or a
 * `ref`) and the kit does not resolve it (only a FIRST `ref` without resolve:false is
 * resolved) — unless its `type` names a string form (uuid, id, name, string), which is how
 * a row says it resolves strings itself (attunement's "Actor|uuid|id|exact name"). An
 * optional one the call leaves out is fine. journal.add(doc), attunement.stash(owner, …)
 * and names.sync(ref, …) are refused this way (names.sync resolves strings but does not
 * say so in its manifest yet).
 *
 * The result travels back as JSON text, made plain in the browser (Documents → {_document,
 * _id, name, uuid}; cycles, Maps/Sets/Collections, depth ≤ 12, arrays ≤ 200), because the
 * eval serializer's depth-4 cap would cut a describe() (methods → params is depth 5).
 * An invalid Date is '[unserializable]'. A write that landed is always `ok: true`: if its
 * result still cannot be serialized, the envelope is `{ok: true, result: '[unserializable]',
 * reason: 'result could not be serialized'}`, never a thrown INTERNAL (rob-1).
 */

import type { FoundryClient } from '../../foundry-client.js';

export const EVAL_QUERY = 'foundry-mcp-bridge.fork.eval';
/** The in-browser eval timeout when a caller gives none (eval-js, pentaryn-read/write). */
export const EVAL_DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Added to the in-browser timeout for the transport, which must outlive it: otherwise a
 * 30 s script is cut at the connector's default 10 s and reported as a transport failure.
 */
export const EVAL_TRANSPORT_MARGIN_MS = 2_000;

export type CallMode = 'read' | 'write';

export interface PentarynCall {
  mode: CallMode;
  /** A namespace of game.pentaryn, or "*" for the root (describe, inspect). */
  ns: string;
  /** A describe().methods[].path, or a kit member (describe, inspect, selftest). */
  path: string;
  ref?: string;
  opts?: Record<string, unknown>;
  dryRun?: boolean;
}

/** What the template returns (as JSON text) and the tools hand back. */
export interface PentarynEnvelope {
  ok: boolean;
  ns: string;
  path: string;
  /** NOT_FOUND, AMBIGUOUS, BAD_ARGS, NOT_GM, REFUSED, CONFLICT, INTERNAL, … on a refusal. */
  code?: string;
  reason?: string;
  /** The method's return value, made plain (a write row's ok()/fail() object). */
  result?: unknown;
  /** On an unknown namespace. */
  namespaces?: string[];
  /** On an unknown path: what the namespace has, and which of those are writes. */
  paths?: string[];
  writes?: Record<string, boolean>;
}

/**
 * The template. Runs as the body of an async function in the GM tab (handlers.ts wraps it
 * in "use strict"). `__CALL__` is replaced by the JSON literal and nothing else.
 */
const TEMPLATE = `
const call = __CALL__;
const KIT = { describe: [], inspect: [{ name: 'ref' }, { name: 'opts' }], selftest: [{ name: 'opts' }] };
const ROOT = { describe: [], inspect: [{ name: 'ref' }, { name: 'opts' }] };
const OPTS = ['opts', 'options'];
const LIMITS = { depth: 12, array: 200, nodes: 20000 };
let nodes = 0;
const plain = (v, depth, stack) => {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') return Number.isFinite(v) ? v : String(v);
  if (t === 'bigint' || t === 'symbol') return v.toString();
  if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
  if (depth > LIMITS.depth) return '[max depth]';
  if (++nodes > LIMITS.nodes) return '[truncated]';
  if (stack.includes(v)) return '[circular]';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '[unserializable]' : v.toISOString();
  if (v instanceof Error) return { error: v.message, ...(v.code ? { code: v.code } : {}) };
  if (v.documentName && v._id !== undefined) {
    return { _document: v.documentName, _id: v._id, name: v.name ?? null, ...(v.uuid ? { uuid: v.uuid } : {}) };
  }
  const inner = stack.concat([v]);
  const list = (items, size) => {
    const out = [];
    for (const x of items) {
      if (out.length >= LIMITS.array) { out.push('[+' + (size - LIMITS.array) + ' more]'); break; }
      out.push(plain(x, depth + 1, inner));
    }
    return out;
  };
  if (Array.isArray(v)) return list(v, v.length);
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
    const items = v instanceof ArrayBuffer ? new Uint8Array(v)
      : v instanceof DataView ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : v;
    return list(items, items.length);
  }
  if (v instanceof Map || v instanceof Set || (typeof v.entries === 'function' && typeof v.size === 'number')) {
    return list(v.values(), v.size);
  }
  const out = {};
  for (const k of Object.keys(v)) {
    if (k.startsWith('_') && k !== '_id') continue;
    let x;
    try { x = v[k]; } catch { out[k] = '[unserializable]'; continue; }
    if (x === undefined) continue;
    out[k] = plain(x, depth + 1, inner);
  }
  return out;
};
const out = env => JSON.stringify(plain(env, 0, []));
const fail = (code, reason, extra) => out({ ok: false, ns: call.ns, path: call.path, code, reason, ...(extra || {}) });
const codeOf = e => {
  if (typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(e.code)) return e.code;
  const m = /^([A-Z][A-Z0-9_]*):/.exec(String(e?.message ?? ''));
  return m ? m[1] : 'INTERNAL';
};
const reasonOf = e => String(e?.message ?? e);
const where = call.ns + '.' + call.path;

const root = globalThis.game?.pentaryn;
if (!root || typeof root !== 'object') {
  return fail('NOT_FOUND', 'game.pentaryn is not installed (no blueprint module is active)');
}
const nsList = () => {
  try {
    if (typeof root.namespaces === 'function') return root.namespaces();
    return Object.keys(root).filter(k => typeof root[k]?.contract === 'string');
  } catch { return []; }
};

if (call.ns === '*') {
  const have = Object.keys(ROOT).filter(k => typeof root[k] === 'function');
  if (!have.includes(call.path)) {
    return fail('NOT_FOUND', 'game.pentaryn.' + call.path + ' is not a root call; the root has ' + have.join(', '),
      { paths: have, namespaces: nsList() });
  }
  if (call.mode !== 'read') return fail('BAD_ARGS', 'game.pentaryn.' + call.path + ' is a read; use pentaryn-read');
  if (call.path === 'describe' && (call.ref !== undefined || Object.keys(call.opts ?? {}).length > 0)) {
    return fail('BAD_ARGS', 'game.pentaryn.describe takes no ref or opts');
  }
  try {
    const result = await (call.path === 'describe' ? root.describe() : root.inspect(call.ref, call.opts ?? {}));
    return out({ ok: true, ns: '*', path: call.path, result });
  } catch (e) {
    return fail(codeOf(e), reasonOf(e));
  }
}

const api = root[call.ns];
if (!api || typeof api !== 'object' || typeof api.contract !== 'string' || typeof api.describe !== 'function') {
  return fail('NOT_FOUND', call.ns + ' is not a blueprint namespace; the others are eval-js only (see the Module APIs index)',
    { namespaces: nsList() });
}
let d;
try { d = api.describe(); } catch (e) { return fail(codeOf(e), call.ns + '.describe() failed: ' + reasonOf(e)); }
const rows = (Array.isArray(d?.methods) ? d.methods : []).filter(m => m && typeof m === 'object');
let row = rows.find(m => m?.path === call.path);
if (!row && Object.hasOwn(KIT, call.path) && typeof api[call.path] === 'function') {
  row = { path: call.path, params: KIT[call.path], writes: false };
}
if (!row) {
  const known = rows.map(m => [m.path, m.writes === true]);
  for (const k of Object.keys(KIT)) {
    if (typeof api[k] === 'function' && !known.some(([p]) => p === k)) known.push([k, false]);
  }
  return fail('NOT_FOUND', where + ' is not a method of ' + call.ns,
    { paths: known.map(([p]) => p), writes: Object.fromEntries(known) });
}
// Fails closed both ways: a row must say writes:false to run as a read (a hand-built
// describe() or a kit regression that drops the key must not reach a write unlogged).
const writes = row.writes === true;
if (call.mode === 'read' && writes) return fail('BAD_ARGS', where + ' is a write row; use pentaryn-write');
if (call.mode === 'read' && row.writes !== false) {
  return fail('BAD_ARGS', where + ' does not declare writes; use pentaryn-write or eval-js');
}
if (call.mode === 'write' && !writes) return fail('BAD_ARGS', where + ' is a read row; use pentaryn-read');

const parts = call.path.split('.');
const owner = parts.slice(0, -1).reduce((o, k) => (o == null ? undefined : o[k]), api);
const fn = owner == null ? undefined : owner[parts.at(-1)];
if (typeof fn !== 'function') return fail('INTERNAL', where + ' is described but is not a function');

const params = Array.isArray(row.params) ? row.params : [];
const names = params.map(p => p?.name);
const takesDryRun = row.dryRun === true ||
  params.some(p => p?.name === 'dryRun' || (String(p?.type ?? '') + ' ' + String(p?.doc ?? '')).includes('dryRun'));
if (call.mode === 'write' && (call.dryRun || call.opts?.dryRun) && !takesDryRun) {
  return fail('BAD_ARGS', where + ' has no dry run; leave dryRun out to run it for real');
}
const bag = { ...(call.opts ?? {}), ...(call.dryRun ? { dryRun: true } : {}) };
const DOC_KINDS = ['actor', 'token', 'item', 'scene', 'user', 'journal', 'message', 'macro', 'region',
  'combat', 'table', 'folder', 'playlist'];
const DOC_TYPES = ['Actor', 'Token', 'Item', 'Scene', 'User', 'JournalEntry', 'JournalEntryPage', 'ChatMessage',
  'Macro', 'Region', 'Combat', 'Combatant', 'RollTable', 'Folder', 'Playlist', 'Wall', 'Tile', 'Drawing',
  'AmbientLight', 'AmbientSound', 'MeasuredTemplate', 'Note', 'Cards', 'Adventure', 'ActiveEffect'];
const STRING_FORMS = ['uuid', 'id', 'name', 'string'];
const typeText = p => (typeof p?.type === 'string' ? p.type : '');
const isDocType = p => {
  const alts = typeText(p).split('|').map(a => a.trim()).filter(Boolean);
  return alts.length > 0 && alts.every(a => DOC_TYPES.includes(a.split(' ')[0]));
};
const takesString = p => typeText(p).toLowerCase().split(/[^a-z0-9_]+/).some(w => STRING_FORMS.includes(w));
const needsDoc = (p, i) => {
  if (p?.name === 'ref' && i === 0 && p.resolve !== false) return false;
  const doc = p?.name === 'ref' || DOC_KINDS.includes(p?.kind) || isDocType(p);
  return doc && !takesString(p);
};
const given = p => (p?.name === 'ref' ? call.ref !== undefined : Object.hasOwn(bag, p?.name));
const live = params.find((p, i) => needsDoc(p, i) && (!p.optional || given(p)));
if (live) {
  return fail('BAD_ARGS', where + ' needs a live Document for ' + live.name + ' (' + (typeText(live) || live.kind || 'ref') +
    ') — eval-js only');
}
const taken = new Set();
let optsAt = -1;
const args = params.map((p, i) => {
  if (p?.name === 'ref') return call.ref;
  if (OPTS.includes(p?.name)) { optsAt = i; return undefined; }
  taken.add(p?.name);
  return bag[p?.name];
});
const rest = Object.fromEntries(Object.entries(bag).filter(([k]) => !taken.has(k)));
if (optsAt >= 0) args[optsAt] = rest;
else if (Object.keys(rest).length) {
  return fail('BAD_ARGS', where + ' takes (' + names.join(', ') + '); not a parameter: ' + Object.keys(rest).join(', '));
}
if (call.ref !== undefined && !names.includes('ref')) {
  return fail('BAD_ARGS', where + ' takes no ref (' + names.join(', ') + ')');
}
while (args.length && args[args.length - 1] === undefined) args.pop();

let result;
try {
  result = await fn.apply(owner, args);
} catch (e) {
  return fail(codeOf(e), reasonOf(e));
}
if (writes && result && typeof result === 'object' && result.ok === false) {
  return out({ ok: false, ns: call.ns, path: call.path, code: typeof result.code === 'string' ? result.code : 'REFUSED',
    reason: result.reason ?? result.error ?? null, result });
}
if (!writes) return out({ ok: true, ns: call.ns, path: call.path, result });
// The write landed: a result that will not serialize must not turn it into a thrown INTERNAL.
try {
  return out({ ok: true, ns: call.ns, path: call.path, result });
} catch {
  return JSON.stringify({ ok: true, ns: call.ns, path: call.path, result: '[unserializable]',
    reason: 'result could not be serialized' });
}
`;

/** The eval script for one call: the fixed template with the call as a JSON literal. */
export function buildCallScript(call: PentarynCall): string {
  const literal: PentarynCall = {
    mode: call.mode,
    ns: call.ns,
    path: call.path,
    ...(call.ref !== undefined ? { ref: call.ref } : {}),
    ...(call.opts !== undefined ? { opts: call.opts } : {}),
    ...(call.dryRun ? { dryRun: true } : {}),
  };
  // A function replacer: `$&`-style patterns in the JSON must not be interpreted.
  return TEMPLATE.replace('__CALL__', () => JSON.stringify(literal));
}

/** A coded Error (`CODE: message`, `code` set), the shape every pentaryn error has. */
export function codedError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Run one call through fork.eval. Module refusals come back as an `{ok: false, code}`
 * envelope; only transport-level failures throw (coded): MODULE_MISSING when the bridge
 * is not connected, TIMEOUT when the GM tab did not answer in time (the call may still
 * be running), the query's own code when its error is `CODE: …` (NOT_GM when the bridge
 * tab is not a GM), INTERNAL otherwise and when the template itself failed.
 */
export async function runPentarynCall(
  foundryClient: Pick<FoundryClient, 'query'>,
  call: PentarynCall,
  timeoutMs: number
): Promise<PentarynEnvelope> {
  const where = `${call.ns}.${call.path}`;
  let r: any;
  try {
    r = await foundryClient.query(
      EVAL_QUERY,
      { script: buildCallScript(call), timeoutMs },
      { timeoutMs: timeoutMs + EVAL_TRANSPORT_MARGIN_MS }
    );
  } catch (err: any) {
    const msg = String(err?.message ?? err).replace(/^Query \S+ failed: /, '');
    if (/not connected|No handler found for query: foundry-mcp-bridge\.fork\.eval/i.test(msg)) {
      throw codedError('MODULE_MISSING', `foundry-mcp-bridge is not connected (${msg})`);
    }
    if (/^Query timeout: /.test(msg)) {
      throw codedError(
        'TIMEOUT',
        `${where} did not answer in ${timeoutMs + EVAL_TRANSPORT_MARGIN_MS} ms; it may still be running — re-read before retrying`
      );
    }
    // A coded refusal from the GM tab (NOT_GM from requireGM, …) keeps its code.
    const coded = /^([A-Z][A-Z0-9_]*): ([\s\S]*)$/.exec(msg);
    if (coded) throw codedError(coded[1], `${where}: ${coded[2]}`);
    throw codedError('INTERNAL', `${where}: ${msg}`);
  }
  if (r?.ok !== true) {
    if (r?.timedOut || /^eval timed out/.test(String(r?.error ?? ''))) {
      throw codedError(
        'TIMEOUT',
        `${where} did not answer in ${timeoutMs} ms; it may still be running — re-read before retrying`
      );
    }
    throw codedError('INTERNAL', `${where}: the call script failed at ${r?.phase}: ${r?.error}`);
  }
  if (typeof r.result !== 'string') {
    throw codedError('INTERNAL', `${where}: the call script returned ${typeof r.result}, not JSON`);
  }
  return JSON.parse(r.result) as PentarynEnvelope;
}
