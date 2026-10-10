/**
 * eval-js — run arbitrary JavaScript inside the Foundry client.
 *
 * The design doc rejected this on principle ("no schema, no validation, silent
 * failures by design"). It is included anyway, for reasons the rejection missed:
 *
 *  1. It adds no capability that does not already exist — the GM has had a
 *     browser console the whole time. What it removes is a copy-paste round trip.
 *  2. The security boundary is unchanged: GM-gated, localhost, one user.
 *  3. Its LOG is the point. Every call is recorded to a dedicated file, so the
 *     question "which real tool should I build next?" gets answered with evidence
 *     instead of speculation.
 *
 * The rejection's one surviving concern is real: the "just eval it" trap, where
 * proper tools never get built because the hatch is always open. The mitigation
 * is the eval log plus periodically reading it — not refusing to build this.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { FoundryClient } from '../../foundry-client.js';
import type { Logger } from '../../logger.js';
import type { ForkRegistry } from '../registry.js';

const ArgsSchema = z.object({
  script: z.string().min(1),
  purpose: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
});

const DEFINITION = {
  name: 'eval-js',
  description:
    'Escape hatch: evaluate JavaScript inside the Foundry client as the GM, and return the ' +
    'serialized result. `game`, `canvas`, `ui` and all document classes are in scope; top-level ' +
    '`await` works. Use when no purpose-built tool covers the need — reach for a real tool first ' +
    'when one exists, because this has no schema and no validation. Every call is logged with its ' +
    'stated purpose so recurring uses can be promoted into proper tools. Foundry documents are ' +
    'serialized to id + name + source data; large collections are truncated.',
  inputSchema: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description:
          'JavaScript to evaluate. The body of an async function — use `return` to produce a value.',
      },
      purpose: {
        type: 'string',
        description:
          'One line on what this is for. Recorded in the eval log; it is what makes the log ' +
          'useful later when deciding which tools to build.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Abort after this many ms (1000-60000, default 10000).',
      },
    },
    required: ['script', 'purpose'],
  },
};

export function registerEvalJs(
  registry: ForkRegistry,
  foundryClient: FoundryClient,
  logger: Logger
): void {
  const log = logger.child({ component: 'eval-js' });

  // Dedicated log, always on — independent of PENTARYN_MCP_LOG_DIR, because the
  // whole justification for this tool is that its usage gets reviewed.
  const logDir = (process.env.PENTARYN_MCP_LOG_DIR ?? '').trim();
  const evalLogPath = logDir ? join(logDir, 'eval.jsonl') : null;
  if (evalLogPath) {
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      /* logged on write */
    }
  }

  registry.register(
    DEFINITION,
    async (rawArgs: unknown) => {
      const args = ArgsSchema.parse(rawArgs);
      log.info(`eval: ${args.purpose}`);

      const started = Date.now();
      let result: any;
      let thrown: unknown;

      try {
        result = await foundryClient.query(
          'foundry-mcp-bridge.fork.eval',
          { script: args.script, timeoutMs: args.timeoutMs },
          // The transport must outlive the in-browser timeout, or a 30 s script is cut at
          // the connector's default 10 s and logged as 'transport' instead of 'runtime'.
          { timeoutMs: (args.timeoutMs ?? 10000) + 2000 }
        );

        return {
          ...result,
          summary: `eval (${args.purpose}) — ${result?.ok ? 'ok' : `failed at ${result?.phase}`}`,
        };
      } catch (err) {
        thrown = err;
        throw err;
      } finally {
        // `finally`, not the success path: a throw on the way to the bridge — module
        // not connected, dead socket, timeout — used to leave no line at all, so the
        // log read as "nothing was attempted" when the truth was "nothing got through".
        // Those calls are phase 'transport', which is not a phase Foundry can report,
        // so they stay distinguishable from a script that failed inside the world.
        if (evalLogPath) {
          try {
            appendFileSync(
              evalLogPath,
              JSON.stringify({
                ts: new Date().toISOString(),
                purpose: args.purpose,
                script: args.script, // full, never truncated — it IS the record
                ok: thrown ? false : (result?.ok ?? false),
                phase: thrown ? 'transport' : result?.phase,
                error: thrown ? String((thrown as any)?.message ?? thrown) : result?.error,
                ms: result?.ms ?? Date.now() - started,
              }) + '\n',
              'utf8'
            );
          } catch (err) {
            log.warn(`eval log write failed: ${err}`);
          }
        }
      }
    },
    { write: true }
  );
}
