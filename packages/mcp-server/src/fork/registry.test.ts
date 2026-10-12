import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ForkRegistry, globToRegExp, type ForkToolHandler } from './registry.js';
import { UPSTREAM_WRITE_GLOBS, isUpstreamWrite } from './upstream-writes.js';
import { ActionLog } from './action-log.js';

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

describe('action log month (mcp-fork-6)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reg-month-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PENTARYN_MCP_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a backend running across a month boundary writes each line into its own month', async () => {
    vi.setSystemTime(new Date('2026-10-31T23:59:00Z'));
    const reg = new ForkRegistry(logger);
    reg.register(DEF('t'), async () => 'ok', { write: true });
    await reg.dispatch('t', {});
    vi.setSystemTime(new Date('2026-11-01T00:01:00Z'));
    await reg.dispatch('t', {});
    const count = (f: string) =>
      existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim().split('\n').length : 0;
    // Before mcp-fork-6 the month was fixed at startup: 2 and 0.
    expect(count('mcp-2026-10.jsonl')).toBe(1);
    expect(count('mcp-2026-11.jsonl')).toBe(1);
  });
});

describe('value failures and logArgs (mcp-fork-4)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reg-4-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.PENTARYN_MCP_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a handler that returns {ok:false} is logged as a failure with its phase and code', async () => {
    const reg = new ForkRegistry(logger);
    const value = { ok: false, phase: 'runtime', code: 'NOT_FOUND', summary: 's' };
    reg.register(DEF('t'), async () => value, { write: true });
    expect(await reg.dispatch('t', {})).toBe(value);
    const [line] = logLines(dir);
    // Before mcp-fork-4 this line said ok:true with no phase or code.
    expect(line).toMatchObject({
      tool: 't',
      ok: false,
      phase: 'runtime',
      code: 'NOT_FOUND',
      summary: 's',
    });
    expect(Object.keys(line)).toEqual([
      'ts',
      'tool',
      'args',
      'ok',
      'phase',
      'code',
      'summary',
      'ms',
    ]);
  });

  it('logArgs shapes the logged args; the handler and result are untouched', async () => {
    const reg = new ForkRegistry(logger);
    const seen: any[] = [];
    const handler = async (a: any) => {
      seen.push(a);
      return { summary: 'done', ids: ['x'] };
    };
    reg.register(DEF('shaped'), handler, {
      write: true,
      logArgs: (a: any) => ({ n: a.script.length }),
    });
    reg.register(DEF('raw'), handler, { write: true });
    const args = { script: 'abc', purpose: 'p' };
    const shaped = await reg.dispatch('shaped', args);
    const raw = await reg.dispatch('raw', args);
    expect(shaped).toEqual(raw);
    expect(seen).toEqual([args, args]);
    const lines = logLines(dir);
    expect(lines[0].args).toEqual({ n: 3 });
    expect(lines[1].args).toEqual(args);
  });

  it('a throwing logArgs falls back to the raw args', async () => {
    const reg = new ForkRegistry(logger);
    reg.register(DEF('t'), async () => 'ok', {
      write: true,
      logArgs: () => {
        throw new Error('nope');
      },
    });
    await reg.dispatch('t', { a: 1 });
    expect(logLines(dir)[0].args).toEqual({ a: 1 });
  });

  it('logArgs applies to the failure line too', async () => {
    const reg = new ForkRegistry(logger);
    reg.register(
      DEF('t'),
      async () => {
        throw new Error('boom');
      },
      { write: true, logArgs: () => ({ hidden: true }) }
    );
    await expect(reg.dispatch('t', { secret: 'x' })).rejects.toThrow('boom');
    expect(logLines(dir)[0]).toMatchObject({ args: { hidden: true }, ok: false, error: 'boom' });
  });

  it('a disabled action log never builds logArgs', async () => {
    const reg = new ForkRegistry(logger, new ActionLog(logger, null));
    const logArgs = vi.fn((a: any) => a);
    reg.register(DEF('ok'), async () => 'done', { write: true, logArgs });
    reg.register(
      DEF('bad'),
      async () => {
        throw new Error('boom');
      },
      { write: true, logArgs }
    );
    expect(await reg.dispatch('ok', { a: 1 })).toBe('done');
    await expect(reg.dispatch('bad', { a: 1 })).rejects.toThrow('boom');
    expect(logArgs).not.toHaveBeenCalled();
  });
});

describe('caller identity (mcp-fork-7)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reg-7-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.PENTARYN_MCP_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('meta.client lands on the line; the handler gets args unchanged plus the meta', async () => {
    const reg = new ForkRegistry(logger);
    const handler = vi.fn(async () => ({ summary: 's' }));
    reg.register(DEF('t'), handler, { write: true });
    const args = { action: 'replace' };
    await reg.dispatch('t', args, { client: { pid: 1, ppid: 2 } });
    await reg.dispatch('t', args);
    expect(handler.mock.calls[0][0]).toBe(args);
    expect(handler.mock.calls[0][1]).toEqual({ client: { pid: 1, ppid: 2 } });
    const [withMeta, without] = logLines(dir);
    expect(withMeta.client).toEqual({ pid: 1, ppid: 2 });
    expect(Object.keys(withMeta)).toEqual([
      'ts',
      'tool',
      'action',
      'args',
      'ok',
      'summary',
      'ms',
      'client',
    ]);
    // no meta: the same keys as before mcp-fork-7
    expect(Object.keys(without)).toEqual(['ts', 'tool', 'action', 'args', 'ok', 'summary', 'ms']);
  });

  it('the failure line carries the client too', async () => {
    const reg = new ForkRegistry(logger);
    reg.register(
      DEF('t'),
      async () => {
        throw new Error('boom');
      },
      { write: true }
    );
    await expect(reg.dispatch('t', {}, { client: { pid: 3, ppid: 4 } })).rejects.toThrow();
    expect(logLines(dir)[0]).toMatchObject({ ok: false, client: { pid: 3, ppid: 4 } });
  });
});

describe('upstream write tools reach the action log (mcp-fork-1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reg-1-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.PENTARYN_MCP_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a write tool is logged with its args, ok and ms', () => {
    const reg = new ForkRegistry(logger);
    reg.auditUpstream(
      'delete-tokens',
      { tokenIds: ['a'] },
      {
        ok: true,
        result: { success: true },
        ms: 3,
        client: { pid: 1, ppid: 2 },
      }
    );
    const lines = logLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tool: 'delete-tokens',
      args: { tokenIds: ['a'] },
      ok: true,
      ms: 3,
      client: { pid: 1, ppid: 2 },
    });
  });

  it('a read tool is not logged', () => {
    const reg = new ForkRegistry(logger);
    reg.auditUpstream('get-character', {}, { ok: true, ms: 1 });
    reg.auditUpstream('list-scenes', {}, { ok: true, ms: 1 });
    expect(logLines(dir)).toEqual([]);
  });

  it('a registered fork tool is not logged twice', () => {
    const reg = new ForkRegistry(logger);
    reg.register(DEF('update-thing'), async () => 'ok', { write: true });
    reg.auditUpstream('update-thing', {}, { ok: true, ms: 1 });
    expect(logLines(dir)).toEqual([]);
  });

  it('a failure is logged with its error', () => {
    const reg = new ForkRegistry(logger);
    reg.auditUpstream('dnd5e-create-npc', { name: 'X' }, { ok: false, error: 'boom', ms: 2 });
    expect(logLines(dir)[0]).toMatchObject({ tool: 'dnd5e-create-npc', ok: false, error: 'boom' });
  });

  it('an upstream {success:false} refusal is logged ok:false with its error (fork-edge-2)', () => {
    const reg = new ForkRegistry(logger);
    reg.auditUpstream(
      'switch-scene',
      { scene: 'Nowhere' },
      { ok: true, result: { success: false, error: 'Scene not found' }, ms: 2 }
    );
    reg.auditUpstream(
      'assign-actor-ownership',
      { actorIdentifier: 'a' },
      { ok: true, result: { success: true }, ms: 1 }
    );
    const lines = logLines(dir);
    expect(lines[0]).toMatchObject({ tool: 'switch-scene', ok: false, error: 'Scene not found' });
    expect(lines[1]).toMatchObject({ tool: 'assign-actor-ownership', ok: true });
    expect(lines[1].error).toBeUndefined();
  });

  it('the glob list covers the upstream write tools and none of the reads', () => {
    const writes = [
      'assign-actor-ownership',
      'cancel-map-job',
      'create-actor-from-compendium',
      'create-campaign-dashboard',
      'create-dsa5-character-from-archetype',
      'create-quest-journal',
      'delete-tokens',
      'dnd5e-add-feature',
      'dnd5e-add-features-from-compendium',
      'dnd5e-create-npc',
      'generate-map',
      'link-quest-to-npc',
      'manage-actors',
      'manage-world-items',
      'move-token',
      'remove-actor-ownership',
      'request-player-rolls',
      'switch-scene',
      'toggle-token-condition',
      'update-quest-journal',
      'update-token',
      'use-item',
      'wfrp4e-add-items',
      'wfrp4e-update-actor',
    ];
    const reads = [
      'check-comfyui-status',
      'check-map-status',
      'get-available-conditions',
      'get-character',
      'get-character-entity',
      'get-compendium-entry-full',
      'get-compendium-item',
      'get-current-scene',
      'get-token-details',
      'get-world-info',
      'list-actor-ownership',
      'list-characters',
      'list-compendium-packs',
      'list-creatures-by-criteria',
      'list-dsa5-archetypes',
      'list-journals',
      'list-scenes',
      'search-character-items',
      'search-compendium',
      'search-journals',
    ];
    expect(writes.filter(n => !isUpstreamWrite(n))).toEqual([]);
    expect(reads.filter(isUpstreamWrite)).toEqual([]);
    expect(UPSTREAM_WRITE_GLOBS.length).toBeGreaterThan(0);
  });

  it('globToRegExp supports only *', () => {
    expect(globToRegExp('a.b*').test('a.bc')).toBe(true);
    expect(globToRegExp('a.b*').test('aXbc')).toBe(false);
    expect(globToRegExp(' x ').test('x')).toBe(true);
  });
});

describe('FOUNDRY_MCP_TOOL_FILTER (mcp-fork-13)', () => {
  afterEach(() => {
    delete process.env.FOUNDRY_MCP_TOOL_FILTER;
  });

  it('denies by glob, hides denied fork tools, and refuses calls to any denied name', async () => {
    process.env.FOUNDRY_MCP_TOOL_FILTER = 'dnd5e-*, generate-map';
    const reg = new ForkRegistry(logger);
    expect(reg.isDenied('dnd5e-create-npc')).toBe(true);
    expect(reg.isDenied('generate-map')).toBe(true);
    expect(reg.isDenied('generate-map-x')).toBe(false);
    expect(reg.isDenied('eval-js')).toBe(false);
    reg.register(DEF('dnd5e-x'), async () => 'ok', { write: false });
    reg.register(DEF('t'), async () => 'ok', { write: false });
    expect(reg.getToolDefinitions().map(d => d.name)).toEqual(['t']);
    await expect(reg.dispatch('dnd5e-x', {})).rejects.toThrow(
      "Tool 'dnd5e-x' is disabled by FOUNDRY_MCP_TOOL_FILTER"
    );
    // Before mcp-fork-13 has() hid denied tools and the backend still dispatched denied
    // upstream tools by name; now has() is plain membership and assertAllowed refuses.
    expect(reg.has('dnd5e-x')).toBe(true);
    expect(() => reg.assertAllowed('dnd5e-create-npc')).toThrow(
      "Tool 'dnd5e-create-npc' is disabled by FOUNDRY_MCP_TOOL_FILTER"
    );
    expect(() => reg.assertAllowed('get-character')).not.toThrow();
  });

  it('unset: nothing is denied', () => {
    const reg = new ForkRegistry(logger);
    reg.register(DEF('t'), async () => 'ok', { write: false });
    expect(reg.isDenied('dnd5e-create-npc')).toBe(false);
    expect(reg.has('t')).toBe(true);
    expect(() => reg.assertAllowed('dnd5e-create-npc')).not.toThrow();
  });
});
