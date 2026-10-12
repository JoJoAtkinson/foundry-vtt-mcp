import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { unregisterForkHandlers } from '../../../../foundry-module/src/fork/handlers.js';
import { ForkRegistry } from '../registry.js';
import { PENTARYN_WRITE_DEFINITION, collectIds, registerPentarynWrite } from './pentaryn-write.js';
import { registerPentarynRead } from './pentaryn-read.js';
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

describe('pentaryn-write', () => {
  useFakeEvalTimers();
  let dir: string;
  let reg: ForkRegistry;
  let client: ReturnType<typeof evalClient>;
  beforeEach(() => {
    calls.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'pwrite-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    installGame();
    reg = new ForkRegistry(logger);
    client = evalClient();
    registerPentarynWrite(reg, client, logger);
  });
  afterEach(() => {
    unregisterForkHandlers();
    vi.restoreAllMocks();
    delete process.env.PENTARYN_MCP_LOG_DIR;
    delete process.env.FOUNDRY_MCP_TOOL_FILTER;
    delete (globalThis as any).game;
    rmSync(dir, { recursive: true, force: true });
  });

  it('dryRun reaches the row as opts.dryRun; summary, ids and the full log line', async () => {
    const args = { ns: 'fake', path: 'store.set', ref: 'Esren', opts: { v: 1 }, dryRun: true };
    const res: any = await reg.dispatch('pentaryn-write', args, { client: { pid: 7, ppid: 1 } });
    expect(calls).toEqual([['set', 'Esren', { v: 1, dryRun: true }]]);
    expect(res).toMatchObject({
      ok: true,
      result: { ok: true, dryRun: true, ids: [] },
      ids: [],
    });
    expect(res.summary).toBe('fake.store.set Esren (dry run) — ok');
    const [line] = lines(dir);
    expect(line).toMatchObject({
      tool: 'pentaryn-write',
      args,
      ok: true,
      summary: 'fake.store.set Esren (dry run) — ok',
      ids: [],
      client: { pid: 7, ppid: 1 },
    });
  });

  it('opts.dryRun counts as a dry run: summary says (dry run) and no ids are logged', async () => {
    (globalThis as any).game.pentaryn.fake.store.set = async (ref: string, opts: any) => {
      calls.push(['set', ref, opts]);
      return { ok: true, dryRun: true, item: { uuid: 'Actor.A1' } };
    };
    const args = { ns: 'fake', path: 'store.set', ref: 'Esren', opts: { dryRun: true } };
    const res: any = await reg.dispatch('pentaryn-write', args);
    expect(calls).toEqual([['set', 'Esren', { dryRun: true }]]);
    expect(res.summary).toBe('fake.store.set Esren (dry run) — ok');
    expect(res.ids).toEqual([]);
    expect(lines(dir)[0]).toMatchObject({
      ok: true,
      summary: 'fake.store.set Esren (dry run) — ok',
      ids: [],
    });
  });

  it('dryRun on a row without one is refused, logged as BAD_ARGS, and nothing runs', async () => {
    unregisterForkHandlers();
    installGame(
      withRow(
        fakeNamespace(),
        {
          path: 'batch.run',
          params: [{ name: 'opts', type: '{ sceneId? }' }],
          gm: true,
          writes: true,
        },
        async (opts: any) => {
          calls.push(['batch.run', opts]);
          return { ok: true, ids: ['w1'] };
        }
      )
    );
    const res: any = await reg.dispatch('pentaryn-write', {
      ns: 'fake',
      path: 'batch.run',
      dryRun: true,
    });
    expect(calls).toEqual([]);
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGS', ids: [] });
    expect(res.reason).toMatch(/has no dry run/);
    expect(res.summary).toBe('fake.batch.run (dry run) — BAD_ARGS');
    expect(lines(dir)[0]).toMatchObject({ ok: false, code: 'BAD_ARGS' });
  });

  it('a real run carries the module ids', async () => {
    const res: any = await reg.dispatch('pentaryn-write', {
      ns: 'fake',
      path: 'store.set',
      ref: 'Esren',
    });
    expect(res.ids).toEqual(['i1']);
    expect(lines(dir)[0]).toMatchObject({ ok: true, ids: ['i1'] });
  });

  it('a result without its own ids logs the documents it returned (dropbin.restoreResult)', async () => {
    unregisterForkHandlers();
    installGame(
      withRow(
        fakeNamespace(),
        { path: 'restoreResult', params: [{ name: 'n', type: 'number' }], gm: true, writes: true },
        async () => ({
          ok: true,
          item: { documentName: 'Item', _id: 'it1', name: 'Sword', uuid: 'Actor.a1.Item.it1' },
          actor: { documentName: 'Actor', _id: 'a1', name: 'Talo', uuid: 'Actor.a1' },
        })
      )
    );
    const res: any = await reg.dispatch('pentaryn-write', {
      ns: 'fake',
      path: 'restoreResult',
      opts: { n: 1 },
    });
    expect(res.ids).toEqual(['Actor.a1.Item.it1', 'Actor.a1']);
    expect(lines(dir)[0]).toMatchObject({ ok: true, ids: ['Actor.a1.Item.it1', 'Actor.a1'] });
  });

  it('a read row is refused, as a value, and logged as a failure with its code', async () => {
    const res: any = await reg.dispatch('pentaryn-write', {
      ns: 'fake',
      path: 'store.list',
      ref: 'E',
    });
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(res.reason).toMatch(/use pentaryn-read/);
    expect(res.summary).toBe('fake.store.list E — BAD_ARGS');
    expect(calls).toEqual([]);
    expect(lines(dir)[0]).toMatchObject({ ok: false, code: 'BAD_ARGS' });
  });

  it("a write row's own refusal is logged ok:false with the module's code", async () => {
    const res: any = await reg.dispatch('pentaryn-write', { ns: 'fake', path: 'refuse' });
    expect(res).toMatchObject({ ok: false, code: 'CONFLICT', summary: 'fake.refuse — CONFLICT' });
    expect(lines(dir)[0]).toMatchObject({ ok: false, code: 'CONFLICT' });
  });

  it('inspect is a read: refused here', async () => {
    const res: any = await reg.dispatch('pentaryn-write', {
      ns: 'fake',
      path: 'inspect',
      ref: 'E',
    });
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGS' });
  });

  it('a zod rejection throws BAD_ARGS and the registry logs ok:false with the error', async () => {
    await expect(
      reg.dispatch('pentaryn-write', { ns: 'fake', path: 'store.set', dryRun: 'yes' })
    ).rejects.toThrow(/^BAD_ARGS: dryRun: /);
    expect(client.sent).toEqual([]);
    const [line] = lines(dir);
    expect(line).toMatchObject({ tool: 'pentaryn-write', ok: false });
    expect(line.error).toMatch(/^BAD_ARGS: /);
  });

  it('the read tool refuses dryRun (strict schema), the write tool accepts it', async () => {
    registerPentarynRead(reg, client, logger);
    await expect(
      reg.dispatch('pentaryn-read', { ns: 'fake', path: 'store.list', dryRun: true })
    ).rejects.toThrow(/^BAD_ARGS: /);
  });

  it('the description names the codes, dryRun and the read tool', () => {
    const d = PENTARYN_WRITE_DEFINITION.description;
    expect(d).toMatch(/NOT_FOUND, AMBIGUOUS, BAD_ARGS, NOT_GM, REFUSED, CONFLICT/);
    expect(d).toMatch(/dryRun:true/);
    expect(d).toMatch(/on any other row it is BAD_ARGS/);
    expect(d).toMatch(/use pentaryn-read/);
  });

  it('FOUNDRY_MCP_TOOL_FILTER=pentaryn-write hides and refuses it', async () => {
    process.env.FOUNDRY_MCP_TOOL_FILTER = 'pentaryn-write';
    const filtered = new ForkRegistry(logger);
    registerPentarynWrite(filtered, client, logger);
    expect(filtered.getToolDefinitions()).toEqual([]);
    expect(() => filtered.assertAllowed('pentaryn-write')).toThrow(
      /disabled by FOUNDRY_MCP_TOOL_FILTER/
    );
  });
});

describe('collectIds (action-log ids from a module result)', () => {
  it('a module ids field wins, strings only', () => {
    expect(collectIds({ ok: true, ids: ['x', 3, 'y'], item: { uuid: 'Item.z' } })).toEqual([
      'x',
      'y',
    ]);
  });

  it('reads {uuid}, {_id}, {id}, documents and arrays of them, de-duplicated', () => {
    expect(
      collectIds({
        ok: true,
        created: [{ _document: 'Item', _id: 'i1', uuid: 'Item.i1' }, { _id: 'i2' }],
        documents: [{ id: 'abcdefghijklmnop' }, { uuid: 'Item.i1' }],
        doc: { _document: 'Actor', _id: 'a1', name: 'A' },
      })
    ).toEqual(['Item.i1', 'i2', 'abcdefghijklmnop', 'a1']);
  });

  it('ignores an id that is not a Foundry id (a condition id, a count)', () => {
    expect(collectIds({ ok: true, condition: { id: 'prone' }, n: { id: 3 } })).toEqual([]);
  });

  it('is bounded in depth and count, and never throws', () => {
    const deep: any = { a: { b: { c: { d: { e: { uuid: 'Too.deep' } } } } } };
    expect(collectIds(deep)).toEqual([]);
    const many = { list: Array.from({ length: 500 }, (_, i) => ({ uuid: `Item.${i}` })) };
    expect(collectIds(many)).toHaveLength(50);
    const cyc: any = { uuid: 'Actor.c' };
    cyc.self = cyc;
    expect(collectIds(cyc)).toEqual(['Actor.c']);
    const hostile = {
      get bad() {
        throw new Error('boom');
      },
    };
    expect(() => collectIds(hostile)).not.toThrow();
    expect(collectIds(null)).toEqual([]);
    expect(collectIds('str')).toEqual([]);
  });
});
