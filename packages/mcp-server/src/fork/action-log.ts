/**
 * The fork's JSONL action logs, one writer for every stream.
 *
 * Enabled by PENTARYN_MCP_LOG_DIR (unset → nothing is written, silently). Streams:
 *   - 'actions' → `mcp-<YYYY-MM>.jsonl`: the registry's write lines (fork tools and the
 *     upstream write tools) and the compact pentaryn-read lines (no `args`; W2-B2);
 *   - 'eval'    → `eval-<YYYY-MM>.jsonl`: eval-js's full-script record. (Before
 *     0.8.3-pentaryn.2 it was one unrotated `eval.jsonl`; that file is left where it is,
 *     and readers glob `eval*.jsonl`.)
 *
 * The month in a file name is the month the line is written in (a long-lived backend
 * crosses month boundaries), not the month the backend started.
 *
 * A write failure never fails a tool call: it is warned once per stream and dropped.
 * Callers build the line object themselves, so key order is theirs.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Logger } from '../logger.js';

export type LogStream = 'actions' | 'eval';

/** File-name stem per stream; a Record so a new LogStream must name its file. */
const STREAM_FILE: Readonly<Record<LogStream, string>> = { actions: 'mcp', eval: 'eval' };

export class ActionLog {
  private readonly dir: string | null;
  private readonly logger: Logger;
  private readonly warned = new Set<LogStream>();

  /** Read PENTARYN_MCP_LOG_DIR and create the directory; disabled when unset or uncreatable. */
  static fromEnv(logger: Logger, env: NodeJS.ProcessEnv = process.env): ActionLog {
    const dir = (env.PENTARYN_MCP_LOG_DIR ?? '').trim();
    return new ActionLog(logger, dir || null);
  }

  constructor(logger: Logger, dir: string | null) {
    this.logger = logger.child({ component: 'ActionLog' });
    let usable = dir;
    if (dir) {
      try {
        mkdirSync(dir, { recursive: true });
        // Resolved path goes in the startup line so an orphaned backend logging
        // to a stale directory is visible rather than mysterious.
        this.logger.info(`fork action log: ${this.pathFor('actions', new Date(), dir)}`);
      } catch (err) {
        this.logger.warn(`fork action log disabled — cannot create ${dir}: ${err}`);
        usable = null;
      }
    }
    this.dir = usable;
  }

  get enabled(): boolean {
    return this.dir !== null;
  }

  /** The file a line written now would go to (null when disabled). */
  pathFor(stream: LogStream, now: Date = new Date(), dir = this.dir): string | null {
    if (!dir) return null;
    const month = now.toISOString().slice(0, 7); // YYYY-MM
    return join(dir, `${STREAM_FILE[stream]}-${month}.jsonl`);
  }

  /** Append one JSON line to a stream. Never throws. */
  append(stream: LogStream, line: object): void {
    const path = this.pathFor(stream);
    if (!path) return;
    try {
      appendFileSync(path, JSON.stringify(line) + '\n', 'utf8');
    } catch (err) {
      if (this.warned.has(stream)) return;
      this.warned.add(stream);
      this.logger.warn(`fork ${stream} log write failed (further failures not reported): ${err}`);
    }
  }
}
