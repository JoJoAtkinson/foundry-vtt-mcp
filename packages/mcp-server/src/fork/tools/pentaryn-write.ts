/**
 * pentaryn-write — call a WRITE method of a Pentaryn blueprint module as the GM (D14).
 * Read rows are refused in the GM tab (pentaryn-call.ts). Every call is a write in the
 * action log, with its arguments (sanitised by the registry), ok, code, summary and ids.
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
    'expected refusal. dryRun:true where the row supports it (bulk rows; run it first). `ref` is ' +
    'resolved by the module, never a substring. Every call is written to the action log with ' +
    'its arguments. Read rows are refused with BAD_ARGS: use pentaryn-read; discover rows with ' +
    'pentaryn-read {ns:"*", path:"describe"}.',
  inputSchema: {
    type: 'object',
    properties: {
      ...CALL_PROPERTIES,
      dryRun: {
        type: 'boolean',
        description: 'Merged into opts as dryRun:true (default false): report what would change.',
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
      const ids = (env.result as any)?.ids;
      return {
        ...env,
        // read by the registry's action-log line (with ok and code)
        summary:
          `${a.ns}.${a.path}${a.ref ? ` ${a.ref}` : ''}${a.dryRun ? ' (dry run)' : ''} — ` +
          (env.ok ? 'ok' : (env.code ?? 'failed')),
        ids: Array.isArray(ids) ? ids.filter((x: unknown) => typeof x === 'string') : [],
      };
    },
    // Logged in full: the args are the record of what was asked (sanitizeForLog caps them).
    { write: true, logArgs: (a: any) => a }
  );
}

export { DEFINITION as PENTARYN_WRITE_DEFINITION };
