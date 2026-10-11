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

import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { Logger } from '../logger.js';
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
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export class ForkRegistry {
  private tools = new Map<string, ForkToolEntry>();
  private denyPatterns: RegExp[];
  private logPath: string | null;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'ForkRegistry' });

    const filter = (process.env.FOUNDRY_MCP_TOOL_FILTER ?? '').trim();
    this.denyPatterns = filter
      ? filter
          .split(',')
          .map(g => g.trim())
          .filter(Boolean)
          .map(globToRegExp)
      : [];

    const logDir = (process.env.PENTARYN_MCP_LOG_DIR ?? '').trim();
    if (logDir) {
      const month = new Date().toISOString().slice(0, 7); // YYYY-MM
      this.logPath = join(logDir, `mcp-${month}.jsonl`);
      try {
        mkdirSync(dirname(this.logPath), { recursive: true });
        // Resolved path goes in the startup line so an orphaned backend logging
        // to a stale directory is visible rather than mysterious.
        this.logger.info(`fork action log: ${this.logPath}`);
      } catch (err) {
        this.logger.warn(`fork action log disabled — cannot create ${logDir}: ${err}`);
        this.logPath = null;
      }
    } else {
      this.logPath = null;
    }

    if (this.denyPatterns.length) {
      this.logger.info(`tool filter active: ${filter}`);
    }
  }

  /**
   * Add a fork tool. `definition` is what `tools/list` shows; `handler` gets the raw
   * arguments (validate them yourself — zod) and returns a {@link ForkToolResult};
   * `opts.write` decides whether a call lands in the action log. Throws on a duplicate
   * name. Expected refusals are better returned as values than thrown: a throw becomes
   * an MCP error with only the message.
   */
  register(
    definition: ForkToolDefinition,
    handler: ForkToolHandler,
    opts: { write: WriteFlag }
  ): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Fork tool registered twice: ${definition.name}`);
    }
    this.tools.set(definition.name, { definition, handler, write: opts.write });
  }

  /** True if this name is denied by FOUNDRY_MCP_TOOL_FILTER. Applies to upstream tools too. */
  isDenied(name: string): boolean {
    return this.denyPatterns.some(re => re.test(name));
  }

  /** Fork tool definitions, minus anything the filter denies. */
  getToolDefinitions(): ForkToolDefinition[] {
    return [...this.tools.values()].map(e => e.definition).filter(d => !this.isDenied(d.name));
  }

  has(name: string): boolean {
    return this.tools.has(name) && !this.isDenied(name);
  }

  async dispatch(name: string, args: any): Promise<any> {
    const entry = this.tools.get(name);
    if (!entry) throw new Error(`Unknown fork tool: ${name}`);
    if (this.isDenied(name))
      throw new Error(`Tool '${name}' is disabled by FOUNDRY_MCP_TOOL_FILTER`);

    const started = Date.now();
    let isWrite = false;
    try {
      isWrite = typeof entry.write === 'function' ? !!entry.write(args) : entry.write;
    } catch {
      isWrite = true; // a predicate that cannot decide logs — the safe side
    }
    try {
      const result = await entry.handler(args);
      if (isWrite) this.log({ tool: name, args, ok: true, result, ms: Date.now() - started });
      return result;
    } catch (err: any) {
      // Failures are logged too — "why did nothing change on Tuesday" is exactly
      // the question a success-only log cannot answer.
      if (isWrite) {
        this.log({
          tool: name,
          args,
          ok: false,
          error: String(err?.message ?? err),
          ms: Date.now() - started,
        });
      }
      throw err;
    }
  }

  private log(entry: {
    tool: string;
    args: unknown;
    ok: boolean;
    result?: any;
    error?: string;
    ms: number;
  }): void {
    if (!this.logPath) return;
    try {
      const line = {
        ts: new Date().toISOString(),
        tool: entry.tool,
        action: (entry.args as any)?.action ?? undefined,
        args: sanitizeForLog(entry.args),
        ok: entry.ok,
        summary: entry.ok ? entry.result?.summary : undefined,
        ids: entry.ok ? entry.result?.ids : undefined,
        error: entry.error,
        ms: entry.ms,
      };
      appendFileSync(this.logPath, JSON.stringify(line) + '\n', 'utf8');
    } catch (err) {
      // Never let logging break a tool call.
      this.logger.warn(`fork action log write failed: ${err}`);
    }
  }
}
