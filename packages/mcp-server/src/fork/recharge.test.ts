import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DnD5eAddFeatureTool } from '../tools/dnd5e/add-feature.js';
import { ActionLog } from './action-log.js';
import { ForkRegistry } from './registry.js';
import { applyRecharge } from './recharge.js';

const logger: any = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

describe('applyRecharge through the typed fork query (mcp-fork-10)', () => {
  // Before mcp-fork-10 recharge went through fork.eval with its own actor lookup (id, exact
  // name, substring) and no token-id fallback. The row it writes is built by foundry-module's
  // rechargeUpdate and pinned there, with the same fixture and the token-id case
  // (packages/foundry-module/src/fork/recharge.test.ts). Its outcome is logged on the
  // add-feature call's own line (registry auditUpstream), not by a second ActionLog here.
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.PENTARYN_MCP_LOG_DIR;
  });
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'recharge-'));
    dirs.push(dir);
    return dir;
  };
  const lines = (dir: string) =>
    readdirSync(dir).flatMap(f =>
      readFileSync(join(dir, f), 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
    );
  const REQ = { actorIdentifier: 'Ogre', itemId: 'I1', featureName: 'Breath', n: 5 };

  it('sends the request to the applyRecharge query and returns the label', async () => {
    const query = vi.fn(async () => ({
      ok: true,
      label: 'Recharge 5–6',
      actorId: 'O1',
      itemId: 'I1',
    }));
    expect(await applyRecharge({ query } as any, REQ, logger)).toBe('Recharge 5–6');
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.fork.applyRecharge', REQ, {
      timeoutMs: 10000,
    });
  });

  it('no label -> the generic text', async () => {
    expect(await applyRecharge({ query: async () => ({ ok: true }) } as any, REQ, logger)).toBe(
      'Recharge 5–6'
    );
  });

  it('the strings add-feature.ts printed before: not applied (<why>)', async () => {
    const failing = { query: async () => ({ ok: false, error: 'x' }) };
    expect(await applyRecharge(failing as any, REQ, logger)).toBe('not applied (x)');
    const throwing = {
      query: async () => {
        throw new Error('No handler found for query: foundry-mcp-bridge.fork.applyRecharge');
      },
    };
    expect(await applyRecharge(throwing as any, REQ, logger)).toBe(
      'not applied (No handler found for query: foundry-mcp-bridge.fork.applyRecharge)'
    );
  });

  it('writes no log line of its own and opens no second ActionLog (was: its own recharge line)', async () => {
    const dir = tmp();
    process.env.PENTARYN_MCP_LOG_DIR = dir;
    const fromEnv = vi.spyOn(ActionLog, 'fromEnv');
    await applyRecharge({ query: async () => ({ ok: true }) } as any, REQ, logger);
    expect(fromEnv).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
    fromEnv.mockRestore();
  });

  it("the add-feature call's upstream line carries the recharge note, its args and client", async () => {
    const dir = tmp();
    const reg = new ForkRegistry(logger, new ActionLog(logger, dir));
    const query = vi.fn(async () => ({ ok: true, label: 'Recharge 5–6' }));
    const tool = new DnD5eAddFeatureTool({ foundryClient: { query } as any, logger });
    (tool as any).dispatchFeature = async () => ({
      message: 'added',
      item: { id: 'I1', name: 'Breath' },
      actor: { id: 'O1', name: 'Ogre' },
    });
    const args = {
      featureType: 'passive',
      actorIdentifier: 'Ogre',
      featureName: 'Breath',
      description: 'x'.repeat(3000),
      recharge: 5,
    };
    const result = await tool.handleAddFeature(args);
    reg.auditUpstream('dnd5e-add-feature', args, {
      ok: true,
      result,
      ms: 4,
      client: { pid: 7, ppid: 1 },
    });
    const [line, ...more] = lines(dir);
    expect(more).toEqual([]);
    expect(line).toMatchObject({
      tool: 'dnd5e-add-feature',
      ok: true,
      recharge: 'Recharge 5–6',
      client: { pid: 7, ppid: 1 },
      args: { actorIdentifier: 'Ogre', recharge: 5, description: { length: 3000 } },
    });
  });

  it("add-feature sends the created actor's and item's ids beside the identifier", async () => {
    const query = vi.fn(async () => ({ ok: true, label: 'Recharge 5–6' }));
    const tool = new DnD5eAddFeatureTool({ foundryClient: { query } as any, logger });
    (tool as any).dispatchFeature = async () => ({
      message: 'added',
      item: { id: 'I1', name: 'Breath' },
      actor: { id: 'O1', name: 'Ogre' },
    });
    const res = await tool.handleAddFeature({
      featureType: 'passive',
      actorIdentifier: 'Og',
      featureName: 'Breath',
      recharge: 5,
    });
    expect(query).toHaveBeenCalledWith(
      'foundry-mcp-bridge.fork.applyRecharge',
      {
        actorIdentifier: 'Og',
        actorId: 'O1',
        itemId: 'I1',
        featureName: 'Breath',
        n: 5,
      },
      { timeoutMs: 10000 }
    );
    expect(res.recharge).toBe('Recharge 5–6');
  });

  it('add-feature no longer builds an eval script for recharge', () => {
    const tool = new DnD5eAddFeatureTool({ foundryClient: { query: vi.fn() } as any, logger });
    expect((tool as any).applyRecharge).toBeUndefined();
  });
});
