import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { unregisterForkHandlers } from '../../../../foundry-module/src/fork/handlers.js';
import { ForkRegistry } from '../registry.js';
import { PENTARYN_WRITE_DEFINITION, registerPentarynWrite } from './pentaryn-write.js';
import { registerPentarynRead } from './pentaryn-read.js';
import { calls, evalClient, installGame } from './pentaryn-call.test.fixtures.js';

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

  it('a real run carries the module ids', async () => {
    const res: any = await reg.dispatch('pentaryn-write', {
      ns: 'fake',
      path: 'store.set',
      ref: 'Esren',
    });
    expect(res.ids).toEqual(['i1']);
    expect(lines(dir)[0]).toMatchObject({ ok: true, ids: ['i1'] });
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
