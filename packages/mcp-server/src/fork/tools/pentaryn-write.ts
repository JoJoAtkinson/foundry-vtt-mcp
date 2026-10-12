/**
 * pentaryn-write — call a WRITE method of a Pentaryn blueprint module as the GM (D14).
 * Read rows are refused in the GM tab (pentaryn-call.ts). Every call is a write in the
 * action log, with its arguments (sanitised by the registry), ok, code, summary and ids
 * (the module's own `ids`, else the documents its result returns — {@link collectIds}).
 */

import { z } from 'zod';
import type { FoundryClient } from '../../foundry-client.js';
import type { Logger } from '../../logger.js';
import type { ForkRegistry } from '../registry.js';
import { runPentarynCall } from './pentaryn-call.js';
import { CALL_PROPERTIES, CallArgs, DEFAULT_TIMEOUT_MS, badArgs } from './pentaryn-read.js';

const WriteArgs = CallArgs.extend({ dryRun: z.boolean().optional() }).strict();

const DEFINITION = {
  name: 'pentaryn-write',
  description:
    'Call a write method (describe().methods[].writes === true) of a Pentaryn blueprint module ' +
    "as the GM: game.pentaryn.<ns>.<path>. Returns the module's {ok, …} or {ok:false, code, " +
    'reason} — NOT_FOUND, AMBIGUOUS, BAD_ARGS, NOT_GM, REFUSED, CONFLICT — never a throw for an ' +
    'expected refusal. dryRun:true where the row declares one (a param type naming dryRun, ' +
    'e.g. importer.import; run it first); on any other row it is BAD_ARGS. `ref` is ' +
    'resolved by the module, never a substring. Every call is written to the action log with ' +
    'its arguments. Read rows are refused with BAD_ARGS: use pentaryn-read; discover rows with ' +
    'pentaryn-read {ns:"*", path:"describe"}.',
  inputSchema: {
    type: 'object',
    properties: {
      ...CALL_PROPERTIES,
      dryRun: {
        type: 'boolean',
        description:
          'Merged into opts as dryRun:true (default false): report what would change. A row ' +
          'without a dry run refuses it with BAD_ARGS instead of running for real.',
      },
    },
    required: ['ns', 'path'],
    additionalProperties: false,
  },
};

export function registerPentarynWrite(
  registry: ForkRegistry,
  foundryClient: Pick<FoundryClient, 'query'>,
  _logger: Logger
): void {
  registry.register(
    DEFINITION,
    async (raw: unknown) => {
      const parsed = WriteArgs.safeParse(raw);
      if (!parsed.success) throw badArgs(parsed.error);
      const a = parsed.data;
      // the same truthiness as the template's `call.dryRun || call.opts?.dryRun`
      const dry = !!a.dryRun || !!(a.opts as any)?.dryRun;
      const env = await runPentarynCall(
        foundryClient,
        {
          mode: 'write',
          ns: a.ns,
          path: a.path,
          ...(a.ref !== undefined ? { ref: a.ref } : {}),
          ...(a.opts !== undefined ? { opts: a.opts } : {}),
          ...(a.dryRun ? { dryRun: true } : {}),
        },
        a.timeoutMs ?? DEFAULT_TIMEOUT_MS
      );
      // a dry run changed nothing, and a refusal has nothing to point at
      const ids = env.ok && !dry ? collectIds(env.result) : [];
      return {
        ...env,
        // read by the registry's action-log line (with ok and code)
        summary:
          `${a.ns}.${a.path}${a.ref ? ` ${a.ref}` : ''}${dry ? ' (dry run)' : ''} — ` +
          (env.ok ? 'ok' : (env.code ?? 'failed')),
        ids,
      };
    },
    { write: true } // logged in full: the args are the record of what was asked (sanitizeForLog caps them)
  );
}

/** Bounds of {@link collectIds}: how deep it looks into a result, and how many ids it keeps. */
const IDS_MAX_DEPTH = 4;
const IDS_MAX = 50;
const FOUNDRY_ID = /^[A-Za-z0-9]{16}$/;

/**
 * The document ids a write's result points at, for the action log's `ids`. A module's own
 * `ids` array wins (strings only). Otherwise the result is walked — depth ≤ 4, ≤ 50 ids,
 * de-duplicated, cycles skipped — and each object contributes one id: its `uuid`, else its
 * `_id` (the serializer keeps `_id` only on Documents), else an `id` shaped like a Foundry id
 * (16 alphanumerics; `{id: "prone"}` is not a document). That covers `{item, actor}`
 * (dropbin.restoreResult), `documents: [...]`, bare arrays and a returned Document stub.
 * Best effort: never throws, returns [] on anything odd.
 */
export function collectIds(result: unknown): string[] {
  try {
    const own = (result as any)?.ids;
    if (Array.isArray(own)) return own.filter((x: unknown) => typeof x === 'string');
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): void => {
    if (out.length >= IDS_MAX || depth > IDS_MAX_DEPTH || !v || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        for (const x of v) walk(x, depth + 1);
        return;
      }
      const o = v as Record<string, unknown>;
      const id =
        typeof o.uuid === 'string' && o.uuid
          ? o.uuid
          : typeof o._id === 'string' && o._id
            ? o._id
            : typeof o.id === 'string' && FOUNDRY_ID.test(o.id)
              ? o.id
              : undefined;
      if (id && !out.includes(id)) out.push(id);
      for (const k of Object.keys(o)) {
        if (out.length >= IDS_MAX) return;
        let child: unknown;
        try {
          child = o[k];
        } catch {
          continue;
        }
        walk(child, depth + 1);
      }
    } catch {
      /* a hostile getter or proxy: keep what we have */
    }
  };
  walk(result, 0);
  return out;
}

export { DEFINITION as PENTARYN_WRITE_DEFINITION };
