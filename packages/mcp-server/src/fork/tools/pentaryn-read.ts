/**
 * pentaryn-read — call a READ method of a Pentaryn blueprint module (D14). The routing,
 * the describe() lookup and the refusal of write rows happen in the GM tab
 * (pentaryn-call.ts). Logged compactly (decision D3): one `{ts, tool, ns, path, ref, ok,
 * code?, ms, client?}` line per call in mcp-<YYYY-MM>.jsonl — no arguments, no result.
 */

import { z } from 'zod';
import type { FoundryClient } from '../../foundry-client.js';
import type { Logger } from '../../logger.js';
import type { ActionLog } from '../action-log.js';
import type { ForkCallMeta, ForkRegistry } from '../registry.js';
import { codedError, runPentarynCall, type PentarynEnvelope } from './pentaryn-call.js';

export const DEFAULT_TIMEOUT_MS = 10_000;

/** The arguments both D14 tools share. */
export const CallArgs = z
  .object({
    ns: z
      .string()
      .min(1)
      .refine(s => !s.includes('.'), 'one namespace, no dots ("*" for the root)'),
    path: z.string().min(1),
    ref: z.string().min(1).optional(),
    opts: z.record(z.unknown()).optional(),
    timeoutMs: z.number().int().min(1000).max(60000).optional(),
  })
  .strict();

/** zod issues → one `BAD_ARGS: path: message; …` error, thrown before any query. */
export function badArgs(err: z.ZodError): Error {
  const lines = err.issues.map(i => `${i.path.join('.') || '(args)'}: ${i.message}`);
  return codedError('BAD_ARGS', lines.join('; '));
}

/** The JSON-schema properties both tools share. */
export const CALL_PROPERTIES = {
  ns: {
    type: 'string',
    description:
      'A game.pentaryn namespace (e.g. "cursors", "importer"), or "*" for the root (path "describe" or "inspect").',
  },
  path: {
    type: 'string',
    description:
      'A method path from describe().methods[].path (e.g. "status", "store.list"), or describe / inspect / selftest.',
  },
  ref: {
    type: 'string',
    description:
      "The row's `ref` argument, resolved by the module: Actor/Token uuid, 16-char id or exact name — never a substring.",
  },
  opts: {
    type: 'object',
    description:
      "The row's options (sceneId, base, as, …); a positional parameter other than ref is given here by its name.",
  },
  timeoutMs: {
    type: 'number',
    description: 'Abort after this many ms (1000-60000, default 10000).',
  },
} as const;

const DEFINITION = {
  name: 'pentaryn-read',
  description:
    'Call a read method of a Pentaryn blueprint module: game.pentaryn.<ns>.<path>. Discovery ' +
    'first: {ns:"*", path:"describe"} returns every namespace\'s manifest, {ns, path:"describe"} ' +
    "one module's rows with params, gm, writes, doc. `ref` is resolved by the module (Actor, " +
    'Token, uuid, id or exact name; ambiguity -> AMBIGUOUS). Write rows are refused with ' +
    'BAD_ARGS: use pentaryn-write. Unknown ns/path -> NOT_FOUND listing what exists. Refusals ' +
    'are values {ok:false, code, reason}. Namespaces without describe() (combat, riders, transform, aoe, …) are ' +
    'eval-js only — see the Module APIs index in context/foundry/README.md. Documents come back ' +
    'as {_document, _id, name, uuid}; depth <=12, arrays <=200.',
  inputSchema: {
    type: 'object',
    properties: CALL_PROPERTIES,
    required: ['ns', 'path'],
    additionalProperties: false,
  },
};

export function registerPentarynRead(
  registry: ForkRegistry,
  foundryClient: Pick<FoundryClient, 'query'>,
  _logger: Logger,
  actionLog: ActionLog = registry.actionLog
): void {
  registry.register(
    DEFINITION,
    async (raw: unknown, meta?: ForkCallMeta) => {
      const parsed = CallArgs.safeParse(raw);
      if (!parsed.success) throw badArgs(parsed.error);
      const a = parsed.data;
      const started = Date.now();
      let env: PentarynEnvelope | undefined;
      let thrownCode: string | undefined;
      try {
        env = await runPentarynCall(
          foundryClient,
          {
            mode: 'read',
            ns: a.ns,
            path: a.path,
            ...(a.ref !== undefined ? { ref: a.ref } : {}),
            ...(a.opts !== undefined ? { opts: a.opts } : {}),
          },
          a.timeoutMs ?? DEFAULT_TIMEOUT_MS
        );
        return env as unknown as Record<string, unknown>;
      } catch (err: any) {
        thrownCode = typeof err?.code === 'string' ? err.code : 'INTERNAL';
        throw err;
      } finally {
        // Compact (D3): what was asked and whether it answered — never the result body.
        actionLog.append('actions', {
          ts: new Date().toISOString(),
          tool: 'pentaryn-read',
          ns: a.ns,
          path: a.path,
          ref: a.ref,
          ok: env?.ok === true,
          code: env ? env.code : thrownCode,
          ms: Date.now() - started,
          client: meta?.client,
        });
      }
    },
    { write: false }
  );
}

export { DEFINITION as PENTARYN_READ_DEFINITION };
