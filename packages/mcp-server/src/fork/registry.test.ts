import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ForkRegistry, type ForkToolHandler } from './registry.js';

const logger: any = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const DEF = (name: string) => ({ name, description: '', inputSchema: {} });

describe('tool contract types (mcp-fork-22)', () => {
  it('accepts the documented result shapes', async () => {
    const reg = new ForkRegistry(logger);
    const str: ForkToolHandler = async () => 'plain text';
    const obj: ForkToolHandler = async () => ({ summary: 's', ids: ['a'], extra: 1 });
    reg.register(DEF('s'), str, { write: false });
    reg.register(DEF('o'), obj, { write: a => !!a?.w });
    expect(await reg.dispatch('s', {})).toBe('plain text');
    expect(await reg.dispatch('o', {})).toEqual({ summary: 's', ids: ['a'], extra: 1 });
    // Type-level pin (checked by `tsc` on this file, not by vitest): ids must be string[].
    // @ts-expect-error ids is string[], not string
    const bad: ForkToolHandler = async () => ({ ids: 'x' });
    void bad;
  });
});

function logLines(dir: string): any[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^mcp-.*\.jsonl$/.test(f))
    .flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean))
    .map(l => JSON.parse(l));
}

describe('action log (characterisation, mcp-fork-5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reg-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.PENTARYN_MCP_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a write:true tool logs one line per call into mcp-<YYYY-MM>.jsonl', async () => {
    const reg = new ForkRegistry(logger);
    reg.register(DEF('t'), async () => ({ summary: 's', ids: ['i'] }), { write: true });
    await reg.dispatch('t', { action: 'replace', n: 1 });
    const month = new Date().toISOString().slice(0, 7);
    expect(readdirSync(dir)).toEqual([`mcp-${month}.jsonl`]);
    const lines = logLines(dir);
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0])).toEqual([
      'ts',
      'tool',
      'action',
      'args',
      'ok',
      'summary',
      'ids',
      'ms',
    ]);
    expect(lines[0]).toMatchObject({
      tool: 't',
      action: 'replace',
      args: { action: 'replace', n: 1 },
      ok: true,
      summary: 's',
      ids: ['i'],
    });
  });

  it('a write:false tool logs nothing', async () => {
    const reg = new ForkRegistry(logger);
    reg.register(DEF('r'), async () => ({ summary: 's' }), { write: false });
    await reg.dispatch('r', {});
    expect(logLines(dir)).toEqual([]);
  });

  it('a throwing write logs ok:false with the error and rethrows', async () => {
    const reg = new ForkRegistry(logger);
    reg.register(
      DEF('t'),
      async () => {
        throw new Error('boom');
      },
      { write: true }
    );
    await expect(reg.dispatch('t', {})).rejects.toThrow('boom');
    const [line] = logLines(dir);
    expect(line).toMatchObject({ tool: 't', ok: false, error: 'boom' });
    expect(line.summary).toBeUndefined();
  });

  it('no PENTARYN_MCP_LOG_DIR -> no file', async () => {
    delete process.env.PENTARYN_MCP_LOG_DIR;
    const reg = new ForkRegistry(logger);
    reg.register(DEF('t'), async () => 'ok', { write: true });
    expect(await reg.dispatch('t', {})).toBe('ok');
    expect(readdirSync(dir)).toEqual([]);
  });
});
