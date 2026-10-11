/**
 * Fork tool registry.
 *
 * Upstream dispatches tools through a hand-written switch in backend.ts. Growing
 * that switch for every added tool is the main rebase hazard of maintaining a
 * fork, so instead this registry hangs off the switch's `default:` case: unknown
 * names fall through to here, and adding a tool touches zero upstream lines.
 *
 * Three things live here because they all want the same single choke point:
 *   - name -> {definition, handler} dispatch
 *   - JSONL action logging (see PENTARYN_MCP_LOG_DIR)
 *   - deny-glob tool filtering (see FOUNDRY_MCP_TOOL_FILTER)
 */

import type { Logger } from '../logger.js';
import { ActionLog } from './action-log.js';
import { isUpstreamWrite } from './upstream-writes.js';
import type { McpContentBlock } from './content.js';

export interface ForkToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Whether a call is a write (logged to the action log) or a read (not logged). A
 * predicate lets one fat tool (an `action` enum) log only its writing actions; a
 * predicate that throws counts as a write.
 */
export type WriteFlag = boolean | ((args: any) => boolean);

/**
 * What a fork tool handler returns. A string is sent as one text block. An object is
 * JSON-stringified into one text block, except:
 *  - `summary` and `ids` are copied into the action-log line of a write;
 *  - `__mcpContent` (non-empty, every entry a valid block) replaces the text block
 *    entirely — the way a tool returns an image (content.ts `toMcpPayload`).
 */
export type ForkToolResult =
  | string
  | ({ summary?: string; ids?: string[]; __mcpContent?: McpContentBlock[] } & Record<
      string,
      unknown
    >);

/** Per-call context the backend passes beside the arguments. Handlers may ignore it. */
export interface ForkCallMeta {
  /** The calling wrapper process (one per Claude session); several share one backend. */
  client?: unknown;
}

export type ForkToolHandler = (args: any, meta?: ForkCallMeta) => Promise<ForkToolResult>;

interface ForkToolEntry {
  definition: ForkToolDefinition;
  handler: ForkToolHandler;
  /** Writes are logged to the action log; reads are not. See {@link WriteFlag}. */
  write: WriteFlag;
  /** What the action-log line records as `args` (default: the raw args). */
  logArgs?: (args: any) => unknown;
}

/** Options of {@link ForkRegistry.register}. */
export interface ForkToolOptions {
  write: WriteFlag;
  /**
   * Shape the `args` written to the action log — drop a bulky field another log already
   * keeps (eval-js's script), or expand a reference (prompt-markers' specFile). A
   * throwing `logArgs` falls back to the raw args. The handler always gets the raw args.
   */
  logArgs?: (args: any) => unknown;
}

/** Truncate anything oversized so a 300-wall import logs its shape, not its coordinates. */
const MAX_LOGGED_ARG_CHARS = 2048;

function sanitizeForLog(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length > 20) return { count: value.length, first: sanitizeForLog(value[0]) };
    return value.map(sanitizeForLog);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = sanitizeForLog(v);
    return out;
  }
  if (typeof value === 'string' && value.length > MAX_LOGGED_ARG_CHARS) {
    return { length: value.length, head: value.slice(0, 120) };
  }
  return value;
}

/**
 * Convert a deny-glob ("dnd5e-*", "generate-map") to a matcher. Only `*` is
 * supported — anything richer invites a regex-injection footgun for no gain.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export class ForkRegistry {
  private tools = new Map<string, ForkToolEntry>();
  private denyPatterns: RegExp[];
  private logger: Logger;
  /** The shared JSONL writer; tools that log their own lines (eval-js) get the same one. */
  readonly actionLog: ActionLog;

  constructor(logger: Logger, actionLog: ActionLog = ActionLog.fromEnv(logger)) {
    this.logger = logger.child({ component: 'ForkRegistry' });
    this.actionLog = actionLog;

    const filter = (process.env.FOUNDRY_MCP_TOOL_FILTER ?? '').trim();
    this.denyPatterns = filter
      ? filter
          .split(',')
          .map(g => g.trim())
          .filter(Boolean)
          .map(globToRegExp)
      : [];

    if (this.denyPatterns.length) {
      this.logger.info(`tool filter active: ${filter}`);
    }
  }

  /**
   * Add a fork tool. `definition` is what `tools/list` shows; `handler` gets the raw
   * arguments (validate them yourself — zod) and returns a {@link ForkToolResult};
   * `opts.write` decides whether a call lands in the action log and `opts.logArgs` what
   * its line records (see {@link ForkToolOptions}). Throws on a duplicate
   * name. Expected refusals are better returned as values than thrown: a throw becomes
   * an MCP error with only the message.
   */
  register(definition: ForkToolDefinition, handler: ForkToolHandler, opts: ForkToolOptions): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Fork tool registered twice: ${definition.name}`);
    }
    this.tools.set(definition.name, {
      definition,
      handler,
      write: opts.write,
      ...(opts.logArgs ? { logArgs: opts.logArgs } : {}),
    });
  }

  /** True if this name is denied by FOUNDRY_MCP_TOOL_FILTER. Applies to upstream tools too. */
  isDenied(name: string): boolean {
    return this.denyPatterns.some(re => re.test(name));
  }

  /** Fork tool definitions, minus anything the filter denies. */
  getToolDefinitions(): ForkToolDefinition[] {
    return [...this.tools.values()].map(e => e.definition).filter(d => !this.isDenied(d.name));
  }

  /**
   * Throw if FOUNDRY_MCP_TOOL_FILTER denies this name — fork or upstream. backend.ts calls
   * it first in `call_tool`, so a filtered tool is refused, not merely hidden from the list.
   */
  assertAllowed(name: string): void {
    if (this.isDenied(name))
      throw new Error(`Tool '${name}' is disabled by FOUNDRY_MCP_TOOL_FILTER`);
  }

  /** Is this a registered fork tool? (The filter is enforced by assertAllowed/dispatch.) */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Run a fork tool; `meta.client` (the calling wrapper) is passed to the handler and logged. */
  async dispatch(name: string, args: any, meta?: ForkCallMeta): Promise<any> {
    const entry = this.tools.get(name);
    if (!entry) throw new Error(`Unknown fork tool: ${name}`);
    this.assertAllowed(name);

    const started = Date.now();
    let isWrite = false;
    try {
      isWrite = typeof entry.write === 'function' ? !!entry.write(args) : entry.write;
    } catch {
      isWrite = true; // a predicate that cannot decide logs — the safe side
    }
    const logged = () => {
      if (!entry.logArgs) return args;
      try {
        return entry.logArgs(args);
      } catch {
        return args;
      }
    };
    try {
      const result = await (meta ? entry.handler(args, meta) : entry.handler(args));
      if (isWrite)
        this.log({
          tool: name,
          action: args?.action,
          args: logged(),
          ok: true,
          result,
          ms: Date.now() - started,
          client: meta?.client,
        });
      return result;
    } catch (err: any) {
      // Failures are logged too — "why did nothing change on Tuesday" is exactly
      // the question a success-only log cannot answer.
      if (isWrite) {
        this.log({
          tool: name,
          action: args?.action,
          args: logged(),
          ok: false,
          error: String(err?.message ?? err),
          ms: Date.now() - started,
          client: meta?.client,
        });
      }
      throw err;
    }
  }

  /**
   * Log a call to an upstream (non-fork) tool if it is a write (upstream-writes.ts).
   * backend.ts calls this for every tool once the call has answered or failed; fork tools
   * return early (dispatch already logged them), and so do reads.
   */
  auditUpstream(
    name: string,
    args: unknown,
    outcome: { ok: boolean; result?: unknown; error?: string; ms: number; client?: unknown }
  ): void {
    if (this.tools.has(name) || !isUpstreamWrite(name)) return;
    this.log({
      tool: name,
      action: (args as any)?.action,
      args,
      ok: outcome.ok,
      result: outcome.result,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ms: outcome.ms,
      client: outcome.client,
    });
  }

  private log(entry: {
    tool: string;
    action?: unknown;
    args: unknown;
    ok: boolean;
    result?: any;
    error?: string;
    ms: number;
    client?: unknown;
  }): void {
    if (!this.actionLog.enabled) return;
    try {
      // A handler that reports failure as a value ({ok:false, phase?, code?}) is a
      // failure in the log too, not ok:true.
      const r = entry.result && typeof entry.result === 'object' ? entry.result : undefined;
      const line = {
        ts: new Date().toISOString(),
        tool: entry.tool,
        action: entry.action ?? undefined,
        args: sanitizeForLog(entry.args),
        ok: entry.ok && r?.ok !== false,
        phase: typeof r?.phase === 'string' ? r.phase : undefined,
        code: typeof r?.code === 'string' ? r.code : undefined,
        summary: entry.ok ? entry.result?.summary : undefined,
        ids: entry.ok ? entry.result?.ids : undefined,
        error: entry.error,
        ms: entry.ms,
        client: entry.client,
      };
      this.actionLog.append('actions', line);
    } catch (err) {
      // Never let logging break a tool call (a summary getter could throw).
      this.logger.warn(`fork action log line failed: ${err}`);
    }
  }
}
