import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ZodError } from 'zod';
import { EVAL_JS_DEFINITION, registerEvalJs } from './eval-js.js';

const logger: any = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

/** Capture the handler eval-js registers, without a real registry. */
function setup(query: (...a: any[]) => Promise<any>) {
  let handler: any;
  let opts: any;
  const fakeRegistry: any = {
    register: (_def: any, h: any, o: any) => {
      handler = h;
      opts = o;
    },
  };
  const client: any = { query: vi.fn(query) };
  registerEvalJs(fakeRegistry, client, logger);
  return { handler, opts, client };
}

/** Every line of every eval*.jsonl file in dir, parsed. */
function evalLines(dir: string): any[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^eval.*\.jsonl$/.test(f))
    .flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean))
    .map(l => JSON.parse(l));
}

describe('eval-js log (characterisation, mcp-fork-5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evaljs-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.PENTARYN_MCP_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends one line with keys ts,purpose,script,ok,phase,ms in that order', async () => {
    const { handler, client } = setup(async () => ({
      ok: true,
      phase: 'complete',
      ms: 2,
      result: 1,
    }));
    const res = await handler({ script: 'return 1', purpose: 'p' });
    expect(res).toMatchObject({ ok: true, result: 1, summary: 'eval (p) — ok' });
    expect(client.query).toHaveBeenCalledWith(
      'foundry-mcp-bridge.fork.eval',
      { script: 'return 1', timeoutMs: undefined },
      { timeoutMs: 12000 }
    );
    const lines = evalLines(dir);
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0])).toEqual(['ts', 'purpose', 'script', 'ok', 'phase', 'ms']);
    expect(lines[0]).toMatchObject({
      purpose: 'p',
      script: 'return 1',
      ok: true,
      phase: 'complete',
      ms: 2,
    });
  });

  it('a transport throw logs phase transport and rethrows', async () => {
    const { handler } = setup(async () => {
      throw new Error('Foundry VTT module not connected');
    });
    await expect(handler({ script: 'return 1', purpose: 'p' })).rejects.toThrow(
      'Foundry VTT module not connected'
    );
    const lines = evalLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ok: false, phase: 'transport' });
    expect(lines[0].error).toMatch(/^Foundry VTT/);
  });

  it('a runtime failure is logged with its error', async () => {
    const { handler } = setup(async () => ({ ok: false, phase: 'runtime', ms: 1, error: 'x' }));
    const res = await handler({ script: 'throw 1', purpose: 'p' });
    expect(res.summary).toBe('eval (p) — failed at runtime');
    expect(evalLines(dir)[0]).toMatchObject({ ok: false, phase: 'runtime', error: 'x', ms: 1 });
  });

  it('a browser-side timeout is marked timedOut on the line (mcp-fork-8)', async () => {
    const { handler } = setup(async () => ({
      ok: false,
      phase: 'runtime',
      ms: 1000,
      error: 'eval timed out after 1000ms',
      timedOut: true,
      note: 'the script may still be running; re-read state before retrying',
    }));
    const res = await handler({ script: 'x', purpose: 'p', timeoutMs: 1000 });
    expect(res.timedOut).toBe(true);
    const [line] = evalLines(dir);
    expect(Object.keys(line)).toEqual([
      'ts',
      'purpose',
      'script',
      'ok',
      'phase',
      'error',
      'timedOut',
      'ms',
    ]);
    expect(line).toMatchObject({ ok: false, phase: 'runtime', timedOut: true });
  });

  it('registers as a write whose action-log args omit the script (mcp-fork-4)', () => {
    const { opts } = setup(async () => ({}));
    expect(opts.write).toBe(true);
    // Before mcp-fork-4 there was no logArgs: the registry line held the whole script too.
    expect(opts.logArgs({ script: 'return 1', purpose: 'p', timeoutMs: 5000 })).toEqual({
      purpose: 'p',
      scriptChars: 8,
      timeoutMs: 5000,
    });
  });

  it('no PENTARYN_MCP_LOG_DIR -> no file, the call still answers', async () => {
    delete process.env.PENTARYN_MCP_LOG_DIR;
    const { handler } = setup(async () => ({ ok: true, phase: 'complete', ms: 1, result: 1 }));
    expect((await handler({ script: 'return 1', purpose: 'p' })).ok).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('eval log file name (python-tooling-30)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evaljs-month-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PENTARYN_MCP_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('rotates monthly: eval-<YYYY-MM>.jsonl, named at write time', async () => {
    vi.setSystemTime(new Date('2026-10-31T23:59:00Z'));
    const { handler } = setup(async () => ({ ok: true, phase: 'complete', ms: 1, result: 1 }));
    await handler({ script: 'return 1', purpose: 'p' });
    vi.setSystemTime(new Date('2026-11-01T00:01:00Z'));
    await handler({ script: 'return 2', purpose: 'p' });
    // Before python-tooling-30 both lines went to one unrotated eval.jsonl.
    expect(readdirSync(dir).sort()).toEqual(['eval-2026-10.jsonl', 'eval-2026-11.jsonl']);
  });
});

describe('bad arguments (mcp-fork-17)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evaljs-args-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.PENTARYN_MCP_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a call missing purpose rejects with the ZodError and is recorded', async () => {
    const { handler, client } = setup(async () => ({ ok: true }));
    const err = await handler({ script: 'return 1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(String(err)).toMatch(/purpose/);
    expect(client.query).not.toHaveBeenCalled();
    // Before mcp-fork-17 nothing reached the eval log.
    const lines = evalLines(dir);
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0])).toEqual([
      'ts',
      'purpose',
      'script',
      'ok',
      'phase',
      'error',
      'ms',
    ]);
    expect(lines[0]).toMatchObject({
      purpose: null,
      script: 'return 1',
      ok: false,
      phase: 'args',
      ms: 0,
    });
    expect(lines[0].error).toMatch(/^purpose: /);
  });

  it('several issues are joined path: message; …', async () => {
    const { handler } = setup(async () => ({ ok: true }));
    await expect(handler({ purpose: 'p', timeoutMs: 500 })).rejects.toBeInstanceOf(ZodError);
    const [line] = evalLines(dir);
    expect(line).toMatchObject({ purpose: 'p', script: null, phase: 'args' });
    expect(line.error).toMatch(/^script: .+; timeoutMs: .+$/);
  });

  it('a non-object argument is recorded with nulls', async () => {
    const { handler } = setup(async () => ({ ok: true }));
    await expect(handler(undefined)).rejects.toBeInstanceOf(ZodError);
    const [line] = evalLines(dir);
    expect(line).toMatchObject({ purpose: null, script: null, phase: 'args' });
    expect(line.error).toMatch(/^\(args\): /);
  });
});

describe('caller identity on the eval line (mcp-fork-7)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evaljs-7-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.PENTARYN_MCP_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies meta.client onto the eval line, last', async () => {
    const { handler } = setup(async () => ({ ok: true, phase: 'complete', ms: 1, result: 1 }));
    await handler({ script: 'return 1', purpose: 'p' }, { client: { pid: 9, ppid: 8 } });
    await handler({ purpose: 'p' }, { client: { pid: 9, ppid: 8 } }).catch(() => {});
    const [ok, bad] = evalLines(dir);
    expect(Object.keys(ok)).toEqual(['ts', 'purpose', 'script', 'ok', 'phase', 'ms', 'client']);
    expect(ok.client).toEqual({ pid: 9, ppid: 8 });
    expect(bad).toMatchObject({ phase: 'args', client: { pid: 9, ppid: 8 } });
  });
});

describe('description (mcp-fork-21)', () => {
  it('states the serializer limits and where pentaryn APIs live', () => {
    const d = EVAL_JS_DEFINITION.description;
    // These numbers are the module's SERIALIZE_LIMITS (foundry-module serialize.test.ts).
    expect(d).toMatch(/depth <=4/);
    expect(d).toMatch(/arrays <=200/);
    expect(d).toMatch(/Collection <=100/);
    expect(d).toMatch(/game\.pentaryn\.describe\(\)/);
  });
});

describe('the action-log line of a rejected call (2026-10-11 live check)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evaljs-args-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.PENTARYN_MCP_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries phase:'args' and a one-line error, as the eval line does", async () => {
    const { ForkRegistry } = await import('../registry.js');
    const reg = new ForkRegistry(logger);
    const client: any = { query: vi.fn(async () => ({ ok: true })) };
    registerEvalJs(reg, client, logger, reg.actionLog);
    await expect(
      reg.dispatch('eval-js', { purpose: 'p', timeoutMs: 500 }, { client: { pid: 1, ppid: 0 } })
    ).rejects.toBeInstanceOf(ZodError);
    expect(client.query).not.toHaveBeenCalled();
    const [line] = readdirSync(dir)
      .filter(f => /^mcp-.*\.jsonl$/.test(f))
      .flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n'))
      .map(l => JSON.parse(l));
    expect(line).toMatchObject({ tool: 'eval-js', ok: false, phase: 'args' });
    expect(line.error).not.toContain('\n');
    expect(line.error).toMatch(/^script: .+; timeoutMs: .+$/);
    const [ev] = evalLines(dir);
    expect(line.error).toBe(ev.error);
  });
});
