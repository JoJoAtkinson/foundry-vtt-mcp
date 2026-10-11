import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { unregisterForkHandlers } from '../../../../foundry-module/src/fork/handlers.js';
import { ForkRegistry } from '../registry.js';
import { PENTARYN_READ_DEFINITION, registerPentarynRead } from './pentaryn-read.js';
import {
  calls,
  evalClient,
  fakeNamespace,
  installGame,
  useFakeEvalTimers,
  withRow,
} from './pentaryn-call.test.fixtures.js';

const logger: any = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

function lines(dir: string): any[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^mcp-.*\.jsonl$/.test(f))
    .flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean))
    .map(l => JSON.parse(l));
}

describe('pentaryn-read', () => {
  useFakeEvalTimers();
  let dir: string;
  let reg: ForkRegistry;
  let client: ReturnType<typeof evalClient>;
  beforeEach(() => {
    calls.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'pread-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    installGame();
    reg = new ForkRegistry(logger);
    client = evalClient();
    registerPentarynRead(reg, client, logger);
  });
  afterEach(() => {
    unregisterForkHandlers();
    vi.restoreAllMocks();
    delete process.env.PENTARYN_MCP_LOG_DIR;
    delete process.env.FOUNDRY_MCP_TOOL_FILTER;
    delete (globalThis as any).game;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a read row and logs one compact line: no args, no result', async () => {
    const res = await reg.dispatch(
      'pentaryn-read',
      { ns: 'fake', path: 'store.list', ref: 'Esren' },
      { client: { pid: 1, ppid: 2 } }
    );
    expect(res).toEqual({ ok: true, ns: 'fake', path: 'store.list', result: { rows: ['Esren'] } });
    const [line, ...more] = lines(dir);
    expect(more).toEqual([]);
    expect(Object.keys(line)).toEqual(['ts', 'tool', 'ns', 'path', 'ref', 'ok', 'ms', 'client']);
    expect(line).toMatchObject({
      tool: 'pentaryn-read',
      ns: 'fake',
      path: 'store.list',
      ref: 'Esren',
      ok: true,
      client: { pid: 1, ppid: 2 },
    });
  });

  it('a module refusal is a value, and its code is on the line', async () => {
    const res: any = await reg.dispatch('pentaryn-read', {
      ns: 'fake',
      path: 'store.list',
      ref: 'Ald',
    });
    expect(res).toMatchObject({ ok: false, code: 'NOT_FOUND', reason: 'NOT_FOUND: actor Ald' });
    expect(calls).toEqual([['list', 'Ald', undefined]]);
    const [line] = lines(dir);
    expect(Object.keys(line)).toEqual(['ts', 'tool', 'ns', 'path', 'ref', 'ok', 'code', 'ms']);
    expect(line).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('a write row is refused with BAD_ARGS naming pentaryn-write', async () => {
    const res: any = await reg.dispatch('pentaryn-read', {
      ns: 'fake',
      path: 'store.set',
      ref: 'E',
    });
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(res.reason).toMatch(/use pentaryn-write/);
    expect(calls).toEqual([]);
  });

  it('a row missing `writes` is refused here, not run, and logged with BAD_ARGS', async () => {
    unregisterForkHandlers();
    installGame(
      withRow(fakeNamespace(), { path: 'odd.touch', params: [], gm: true }, async () => {
        calls.push(['odd.touch']);
        return { ok: true };
      })
    );
    const res: any = await reg.dispatch('pentaryn-read', { ns: 'fake', path: 'odd.touch' });
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(res.reason).toMatch(/does not declare writes/);
    expect(calls).toEqual([]);
    expect(lines(dir)[0]).toMatchObject({ tool: 'pentaryn-read', ok: false, code: 'BAD_ARGS' });
  });

  it('root describe and namespace NOT_FOUND', async () => {
    const root: any = await reg.dispatch('pentaryn-read', { ns: '*', path: 'describe' });
    expect(Object.keys(root.result.namespaces)).toEqual(['fake']);
    const miss: any = await reg.dispatch('pentaryn-read', { ns: 'ties', path: 'x' });
    expect(miss).toMatchObject({ ok: false, code: 'NOT_FOUND', namespaces: ['fake'] });
  });

  it('timeoutMs reaches the eval, +2000 on the transport', async () => {
    await reg.dispatch('pentaryn-read', { ns: 'fake', path: 'deep', timeoutMs: 3000 });
    expect(client.sent[0].data.timeoutMs).toBe(3000);
    expect(client.sent[0].opts).toEqual({ timeoutMs: 5000 });
    await reg.dispatch('pentaryn-read', { ns: 'fake', path: 'deep' });
    expect(client.sent[1].data.timeoutMs).toBe(10000);
  });

  it('bad arguments throw BAD_ARGS before any query and log nothing', async () => {
    for (const bad of [
      { ns: 'fake' },
      { ns: 'a.b', path: 'x' },
      { ns: 'fake', path: 'x', dryRun: true },
      { ns: 'fake', path: 'x', opts: [] },
      { ns: 'fake', path: 'x', timeoutMs: 500 },
    ]) {
      await expect(reg.dispatch('pentaryn-read', bad)).rejects.toThrow(/^BAD_ARGS: /);
    }
    expect(client.sent).toEqual([]);
    expect(lines(dir)).toEqual([]);
  });

  it('a transport failure throws a coded error and still logs the attempt', async () => {
    const reg2 = new ForkRegistry(logger);
    registerPentarynRead(
      reg2,
      {
        query: async () => {
          throw new Error('Foundry VTT module not connected.');
        },
      },
      logger
    );
    await expect(reg2.dispatch('pentaryn-read', { ns: 'fake', path: 'deep' })).rejects.toThrow(
      /^MODULE_MISSING: /
    );
    expect(lines(dir)).toEqual([
      expect.objectContaining({ tool: 'pentaryn-read', ok: false, code: 'MODULE_MISSING' }),
    ]);
  });

  it('NOT_GM from the bridge tab is thrown and logged as NOT_GM, not INTERNAL', async () => {
    const reg2 = new ForkRegistry(logger);
    registerPentarynRead(
      reg2,
      {
        query: async () => {
          throw new Error(
            'Query foundry-mcp-bridge.fork.eval failed: NOT_GM: Access denied: fork tools require a GM session.'
          );
        },
      },
      logger
    );
    await expect(
      reg2.dispatch('pentaryn-read', { ns: 'fake', path: 'deep' })
    ).rejects.toMatchObject({
      code: 'NOT_GM',
    });
    expect(lines(dir)).toEqual([
      expect.objectContaining({ tool: 'pentaryn-read', ok: false, code: 'NOT_GM' }),
    ]);
  });

  it('the description names the discovery call and the write tool', () => {
    expect(PENTARYN_READ_DEFINITION.description).toMatch(/\{ns:"\*", path:"describe"\}/);
    expect(PENTARYN_READ_DEFINITION.description).toMatch(/use pentaryn-write/);
  });

  it('FOUNDRY_MCP_TOOL_FILTER hides and refuses it', async () => {
    process.env.FOUNDRY_MCP_TOOL_FILTER = 'pentaryn-read';
    const filtered = new ForkRegistry(logger);
    registerPentarynRead(filtered, client, logger);
    expect(filtered.getToolDefinitions().map(d => d.name)).not.toContain('pentaryn-read');
    expect(() => filtered.assertAllowed('pentaryn-read')).toThrow(
      /disabled by FOUNDRY_MCP_TOOL_FILTER/
    );
    await expect(filtered.dispatch('pentaryn-read', { ns: '*', path: 'describe' })).rejects.toThrow(
      /disabled/
    );
  });
});
