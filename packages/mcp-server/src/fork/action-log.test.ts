import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ActionLog } from './action-log.js';

function makeLogger() {
  const logger: any = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.child = () => logger;
  return logger;
}

describe('ActionLog', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'alog-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('is disabled when PENTARYN_MCP_LOG_DIR is unset or blank', () => {
    const logger = makeLogger();
    expect(ActionLog.fromEnv(logger, {}).enabled).toBe(false);
    expect(ActionLog.fromEnv(logger, { PENTARYN_MCP_LOG_DIR: '  ' }).enabled).toBe(false);
    ActionLog.fromEnv(logger, {}).append('actions', { a: 1 }); // no throw
  });

  it('creates the directory and names the actions file in the startup line', () => {
    const dir = join(tmp(), 'nested', 'logs');
    const logger = makeLogger();
    const log = ActionLog.fromEnv(logger, { PENTARYN_MCP_LOG_DIR: dir });
    expect(log.enabled).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/fork action log: .*mcp-\d{4}-\d{2}\.jsonl$/)
    );
    log.append('eval', { b: 2 });
    expect(readFileSync(join(dir, 'eval.jsonl'), 'utf8')).toBe('{"b":2}\n');
  });

  it('an uncreatable directory disables the log with one warning', () => {
    const parent = tmp();
    const file = join(parent, 'not-a-dir');
    writeFileSync(file, 'x');
    const logger = makeLogger();
    const log = ActionLog.fromEnv(logger, { PENTARYN_MCP_LOG_DIR: join(file, 'logs') });
    expect(log.enabled).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    log.append('actions', { a: 1 }); // no throw, no second warning
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a failing append never throws and warns once per stream', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'eval.jsonl')); // appendFileSync on a directory -> EISDIR
    const logger = makeLogger();
    const log = new ActionLog(logger, dir);
    log.append('eval', { a: 1 });
    log.append('eval', { a: 2 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/fork eval log write failed/);
    log.append('actions', { a: 3 }); // the other stream still works
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
